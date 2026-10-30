import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenAI } from '@google/genai';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER_API_KEY = 'your_gemini_api_key_here';

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readApiKey() {
  const key = process.env.GEMINI_API_KEY?.trim();
  return !key || key === PLACEHOLDER_API_KEY ? '' : key;
}

const PORT = readPositiveInt(process.env.PORT, 3000);
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const GEMINI_API_KEY = readApiKey();
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-3.6-flash';
const GEMINI_IMAGE_MODEL =
  process.env.GEMINI_IMAGE_MODEL?.trim() || 'gemini-3.1-flash-image';
const MAX_PROMPT_LENGTH = readPositiveInt(process.env.MAX_PROMPT_LENGTH, 4000);
const IMAGE_MAX_PROMPT_LENGTH = readPositiveInt(
  process.env.IMAGE_MAX_PROMPT_LENGTH,
  1000,
);
const MAX_REQUEST_TIMEOUT_MS = 50_000; // 50 seconds, to keep requests inside the extension's 70s client timeout
const configuredRequestTimeoutMs = readPositiveInt(process.env.REQUEST_TIMEOUT_MS, 60_000);
const REQUEST_TIMEOUT_MS = Math.min(configuredRequestTimeoutMs, MAX_REQUEST_TIMEOUT_MS);
const GEMINI_MAX_ATTEMPTS = readPositiveInt(process.env.GEMINI_MAX_ATTEMPTS, 2);
const RATE_LIMIT_MAX = readPositiveInt(process.env.RATE_LIMIT_MAX, 15);
const RATE_LIMIT_WINDOW_MS = readPositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 30_000);
// Image generation is much more expensive than text, so it gets a tighter limit.
const RATE_LIMIT_IMAGE_MAX = readPositiveInt(process.env.RATE_LIMIT_IMAGE_MAX, 6);

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const SYSTEM_INSTRUCTION = [
  'You are a helpful AI assistant embedded in a Chrome extension.',
  'Answer clearly and accurately, and keep responses reasonably concise.',
  'Use plain text with short paragraphs and simple lists when useful.',
  'If you are unsure, say so instead of inventing information.',
].join(' ');

/* Response recipes the frontend can pick from. Keys must stay in sync with the
 * TEMPLATES list in popup.js. */
const PROMPT_TEMPLATES = Object.freeze({
  general: {
    instruction:
      'Answer clearly and directly. Use plain text with short paragraphs and simple lists when useful. If you are unsure, say so.',
  },
  explain: {
    instruction:
      'Explain the subject clearly and step by step. Define jargon, use a concrete example or analogy, and finish with a one-sentence takeaway.',
  },
  summarize: {
    instruction:
      'Summarize the key points concisely. Lead with the main takeaway, then list the supporting points in order of importance. Omit filler and keep names, numbers and facts exact.',
  },
  code: {
    instruction:
      'Act as a senior software engineer. Provide correct, runnable code, keep it minimal, and briefly explain key decisions, assumptions, and edge cases. Use fenced code blocks with a language tag.',
  },
  creative: {
    instruction:
      'Write with a distinctive, vivid voice. Use concrete imagery, strong verbs, and natural rhythm. Avoid cliches and generic filler.',
  },
});

/* Response-depth presets. These shape both the instruction and Gemini's
 * generation budget. Keys must stay in sync with the DEPTHS list in popup.js. */
const RESPONSE_MODES = Object.freeze({
  quick: {
    instruction:
      'Be concise. Aim for one to three short paragraphs or a compact list. Skip preamble and repetition.',
    maxOutputTokens: 512,
    thinkingLevel: 'low',
  },
  balanced: {
    instruction:
      'Give a clear, well-structured answer with enough detail to be useful. Use headings or lists only when they improve clarity.',
    maxOutputTokens: 2048,
    thinkingLevel: 'medium',
  },
  detailed: {
    instruction:
      'Think carefully and give a thorough answer. Include relevant context, examples, trade-offs or edge cases, and a short summary. Stay focused and avoid padding.',
    maxOutputTokens: 8192,
    thinkingLevel: 'high',
  },
});

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: { timeout: REQUEST_TIMEOUT_MS },
    })
  : null;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isAllowedOrigin(origin) {
  // Chromium sends "chrome-extension://<extension-id>" from extension pages.
  // The ID changes for unpacked extensions, so the scheme is the stable part.
  return origin.startsWith('chrome-extension://') || ALLOWED_ORIGINS.has(origin);
}

function safeHasOwn(map, value) {
  return typeof value === 'string' && Object.hasOwn(map, value);
}

function buildSystemInstruction(template, responseMode) {
  return [
    SYSTEM_INSTRUCTION,
    PROMPT_TEMPLATES[template].instruction,
    RESPONSE_MODES[responseMode].instruction,
  ].join(' ');
}

/** Validates optional template/depth keys and applies the defaults. */
function validateOptions(templateValue, responseModeValue) {
  const template = templateValue ?? 'general';
  const responseMode = responseModeValue ?? 'balanced';

  if (!safeHasOwn(PROMPT_TEMPLATES, template)) {
    return {
      error: {
        status: 400,
        code: 'INVALID_TEMPLATE',
        message: `Template must be one of: ${Object.keys(PROMPT_TEMPLATES).join(', ')}.`,
      },
    };
  }

  if (!safeHasOwn(RESPONSE_MODES, responseMode)) {
    return {
      error: {
        status: 400,
        code: 'INVALID_RESPONSE_MODE',
        message: `Response depth must be one of: ${Object.keys(RESPONSE_MODES).join(', ')}.`,
      },
    };
  }

  return { template, responseMode };
}

function redactSecrets(message) {
  const text = String(message ?? '');
  return GEMINI_API_KEY ? text.replaceAll(GEMINI_API_KEY, '[redacted]') : text;
}

function sendError(res, status, code, message, extraHeaders = {}) {
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.set(name, value);
  }
  return res.status(status).json({ error: { code, message } });
}

/**
 * Normalizes and validates the prompt. HTML is intentionally allowed because
 * prompts may legitimately contain markup or code; the response is rendered as
 * plain text in the extension, so it is never interpreted as HTML.
 */
function validatePrompt(value) {
  if (typeof value !== 'string') {
    return {
      error: {
        status: 400,
        code: 'INVALID_PROMPT',
        message: 'A prompt is required.',
      },
    };
  }

  const prompt = value
    .replace(/\r\n?/g, '\n')
    // Strip control characters except tab (09) and newline (0A).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  if (!prompt) {
    return {
      error: {
        status: 400,
        code: 'EMPTY_PROMPT',
        message: 'Please enter a prompt before generating.',
      },
    };
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      error: {
        status: 400,
        code: 'PROMPT_TOO_LONG',
        message: `The prompt must be ${MAX_PROMPT_LENGTH.toLocaleString('en-US')} characters or fewer.`,
      },
    };
  }

  return { prompt };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Only transient server-side failures are retried. Timeouts are not retried
 * because the first attempt already consumed the request budget.
 */
function isRetryableError(error) {
  const status = Number(error?.status);
  const name = String(error?.name ?? '');

  if (name.includes('Timeout')) return false;

  return (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    name === 'APIConnectionError'
  );
}

const MIN_RETRY_BUDGET_MS = 5_000;

async function requestInteraction(prompt, systemInstruction, responseMode) {
  const mode = RESPONSE_MODES[responseMode];
  // A single deadline keeps the total time across retries inside the
  // extension's client timeout (70s).
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError;

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      return await ai.interactions.create(
        {
          model: GEMINI_MODEL,
          input: prompt,
          system_instruction: systemInstruction,
          generation_config: {
            thinking_level: mode.thinkingLevel,
            max_output_tokens: mode.maxOutputTokens,
          },
          store: false,
        },
        { timeout_ms: remainingMs },
      );
    } catch (error) {
      lastError = error;

      if (attempt >= GEMINI_MAX_ATTEMPTS || !isRetryableError(error)) {
        throw error;
      }

      const delayMs = 1_000 * attempt;
      if (deadline - Date.now() - delayMs < MIN_RETRY_BUDGET_MS) {
        throw error;
      }

      console.warn(
        `[generate] Gemini returned ${error?.status ?? error?.name ?? 'a transient error'}; retrying in ${delayMs} ms (attempt ${attempt + 1}/${GEMINI_MAX_ATTEMPTS})`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('The Gemini request budget was exhausted.');
}

/**
 * Generates an image with Gemini's image model. The response is returned as a
 * data URL (`data:image/png;base64,...`), which the extension can render and
 * download directly. Retries use the same deadline pattern as text generation.
 */
async function requestImage(prompt) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError;

  for (let attempt = 1; attempt <= GEMINI_MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    try {
      const result = await ai.models.generateContent({
        model: GEMINI_IMAGE_MODEL,
        contents: prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });

      const parts = result.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find((part) => part.inlineData?.data);

      return {
        dataUrl: imagePart
          ? `data:${imagePart.inlineData.mimeType || 'image/png'};base64,${imagePart.inlineData.data}`
          : null,
      };
    } catch (error) {
      lastError = error;

      if (attempt >= GEMINI_MAX_ATTEMPTS || !isRetryableError(error)) {
        throw error;
      }

      const delayMs = 1_000 * attempt;
      if (deadline - Date.now() - delayMs < MIN_RETRY_BUDGET_MS) {
        throw error;
      }

      console.warn(
        `[image] Gemini returned ${error?.status ?? error?.name ?? 'a transient error'}; retrying in ${delayMs} ms (attempt ${attempt + 1}/${GEMINI_MAX_ATTEMPTS})`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('The Gemini image request budget was exhausted.');
}

function mapGeminiError(error, res) {
  const status = Number(error?.status);
  const name = String(error?.name ?? '');
  const message = redactSecrets(error?.message);

  console.error(
    `[generate] Gemini request failed: name=${name || 'unknown'} status=${Number.isFinite(status) ? status : 'n/a'} message=${message || 'n/a'}`,
  );

  if (name === 'AbortError' || name.includes('Timeout') || /timed?\s*out|timeout/i.test(message)) {
    return sendError(
      res,
      504,
      'AI_TIMEOUT',
      'The AI service took too long to respond. Please try again.',
    );
  }

  if (status === 429) {
    // Distinguish "service is busy" from "this key has no quota left". The
    // Gemini API reports both as 429 but with different messages.
    if (
      /exceeded your current quota|billing details|upgrade your tier|per day on free tier/i.test(
        message,
      )
    ) {
      return sendError(
        res,
        429,
        'AI_QUOTA_EXCEEDED',
        'The free daily quota of this API key is used up for this model. Wait for the daily reset, or upgrade the tier (https://ai.dev/rate-limit) to keep going.',
        { 'Retry-After': '300' },
      );
    }
    return sendError(
      res,
      429,
      'AI_RATE_LIMITED',
      'The AI service is busy right now. Please wait a moment and try again.',
      { 'Retry-After': '30' },
    );
  }

  if (status === 401 || status === 403) {
    return sendError(
      res,
      502,
      'AI_AUTH_ERROR',
      'The AI service is unavailable because of a configuration problem.',
    );
  }

  if (status === 400 || status === 422) {
    return sendError(
      res,
      502,
      'AI_REQUEST_REJECTED',
      'The AI service rejected the request. Check the prompt and the backend configuration, then try again.',
    );
  }

  if (status === 503) {
    return sendError(
      res,
      503,
      'AI_UNAVAILABLE',
      'Gemini is experiencing high demand right now. Please try again in a moment.',
      { 'Retry-After': '15' },
    );
  }

  if (status === 500 || status === 502 || status === 504) {
    return sendError(
      res,
      502,
      'AI_SERVICE_ERROR',
      'Gemini is temporarily unavailable. Please try again in a moment.',
      { 'Retry-After': '10' },
    );
  }

  return sendError(
    res,
    502,
    'AI_SERVICE_ERROR',
    'The AI service could not complete the request. Please try again.',
  );
}

/* -------------------------------------------------------------------------- */
/* App setup                                                                  */
/* -------------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86_400,
  }),
);

// Reject browser requests from origins that are not the extension or an
// explicitly configured origin. Requests without an Origin header (curl,
// server-to-server) are allowed and still protected by the rate limiter.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !isAllowedOrigin(origin)) {
    return sendError(res, 403, 'FORBIDDEN_ORIGIN', 'This origin is not allowed.');
  }
  next();
});

app.use(express.json({ limit: '16kb', strict: true }));

/* In-memory, per-IP rate limiters for the AI endpoints. These are intentionally
 * dependency-free; for a horizontally scaled deployment, use shared storage. */
function createRateLimiter(max, windowMs) {
  const buckets = new Map();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return sendError(
        res,
        429,
        'RATE_LIMITED',
        'Too many requests. Please wait a moment and try again.',
        { 'Retry-After': String(retryAfter) },
      );
    }

    return next();
  };

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) {
        buckets.delete(key);
      }
    }
  }, windowMs);
  cleanupTimer.unref();

  return middleware;
}

const textRateLimit = createRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
const imageRateLimit = createRateLimiter(RATE_LIMIT_IMAGE_MAX, RATE_LIMIT_WINDOW_MS);

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'ai-chrome-extension-backend',
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/generate', textRateLimit, async (req, res) => {
  const { prompt, error } = validatePrompt(req.body?.prompt);
  if (error) {
    return sendError(res, error.status, error.code, error.message);
  }

  const options = validateOptions(req.body?.template, req.body?.responseMode);
  if (options.error) {
    return sendError(res, options.error.status, options.error.code, options.error.message);
  }

  if (!ai) {
    console.error('[generate] GEMINI_API_KEY is missing or still set to the placeholder value.');
    return sendError(
      res,
      503,
      'AI_NOT_CONFIGURED',
      'The AI service is not configured yet. Add a Gemini API key to the backend .env file and restart the server.',
    );
  }

  try {
    const interaction = await requestInteraction(
      prompt,
      buildSystemInstruction(options.template, options.responseMode),
      options.responseMode,
    );

    const text = interaction.output_text?.trim();
    if (!text) {
      return sendError(
        res,
        502,
        'EMPTY_AI_RESPONSE',
        'The AI returned an empty response. Please try again.',
      );
    }

    return res.status(200).json({
      response: text,
      model: GEMINI_MODEL,
      template: options.template,
      responseMode: options.responseMode,
    });
  } catch (err) {
    return mapGeminiError(err, res);
  }
});

app.post(['/api/generate-image', '/api/image'], imageRateLimit, async (req, res) => {
  const { prompt, error } = validatePrompt(req.body?.prompt);
  if (error) {
    return sendError(res, error.status, error.code, error.message);
  }

  if (prompt.length > IMAGE_MAX_PROMPT_LENGTH) {
    return sendError(
      res,
      400,
      'PROMPT_TOO_LONG',
      `The image prompt must be ${IMAGE_MAX_PROMPT_LENGTH.toLocaleString('en-US')} characters or fewer.`,
    );
  }

  if (!ai) {
    console.error('[image] GEMINI_API_KEY is missing or still set to the placeholder value.');
    return sendError(
      res,
      503,
      'AI_NOT_CONFIGURED',
      'The AI service is not configured yet. Add a Gemini API key to the backend .env file and restart the server.',
    );
  }

  try {
    const { dataUrl } = await requestImage(prompt);

    if (!dataUrl) {
      return sendError(
        res,
        502,
        'EMPTY_AI_RESPONSE',
        'The AI did not return an image. Try rephrasing the prompt and generate again.',
      );
    }

    return res.status(200).json({
      image: dataUrl,
      model: GEMINI_IMAGE_MODEL,
    });
  } catch (err) {
    return mapGeminiError(err, res);
  }
});

app.use((req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'The requested endpoint was not found.');
});

// Central error handler for malformed JSON, oversized bodies, and unexpected
// failures. Internal details are logged server-side but never sent to clients.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, 400, 'INVALID_JSON', 'The request body must be valid JSON.');
  }

  if (err?.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }

  console.error('[server] Unhandled error:', redactSecrets(err?.stack || err?.message || err));
  return sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
});

/* -------------------------------------------------------------------------- */
/* Startup                                                                    */
/* -------------------------------------------------------------------------- */

const server = app.listen(PORT, HOST, () => {
  console.log(`Backend listening on http://${HOST}:${PORT}`);
  console.log(`Health check: http://${HOST}:${PORT}/api/health`);
  console.log(`Gemini model: ${GEMINI_MODEL}`);
  console.log(`Gemini image model: ${GEMINI_IMAGE_MODEL}`);
  if (configuredRequestTimeoutMs > REQUEST_TIMEOUT_MS) {
    console.warn(
      `WARNING: REQUEST_TIMEOUT_MS=${configuredRequestTimeoutMs} exceeds the safe maximum. Using ${REQUEST_TIMEOUT_MS} ms so requests finish before the extension's 70s client timeout.`,
    );
  }
  if (!ai) {
    console.warn(
      'WARNING: GEMINI_API_KEY is missing or still set to the placeholder. /api/generate and /api/generate-image will return 503 until it is configured.',
    );
  }
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
