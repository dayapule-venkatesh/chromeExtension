import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3199;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;
let serverOutput = '';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(100);
  }

  throw new Error(`Test server did not start.\n${serverOutput}`);
}

function postGenerate(body, headers = {}) {
  return fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function postImage(body, headers = {}) {
  return fetch(`${BASE_URL}/api/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * Fails fast if another process is already listening on the test port. Without
 * this check the suite could silently run against a stale server.
 */
function assertPortIsFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Test port ${port} is already in use. Stop the process using it and rerun the tests.`,
          ),
        );
        return;
      }
      reject(error);
    });

    probe.once('listening', () => {
      probe.close(() => resolve());
    });

    probe.listen(port, '127.0.0.1');
  });
}

before(async () => {
  await assertPortIsFree(PORT);

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      GEMINI_API_KEY: '',
      RATE_LIMIT_MAX: '100',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  serverProcess.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  await waitForServer();
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await delay(100);
  }
});

test('GET /api/health returns a healthy response', async () => {
  const response = await fetch(`${BASE_URL}/api/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'ai-chrome-extension-backend');
  assert.ok(Date.parse(body.timestamp));
});

test('POST /api/generate rejects an empty prompt', async () => {
  const response = await postGenerate({ prompt: '   ' });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'EMPTY_PROMPT');
});

test('POST /api/generate rejects a missing prompt', async () => {
  const response = await postGenerate({});
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_PROMPT');
});

test('POST /api/generate rejects a non-string prompt', async () => {
  const response = await postGenerate({ prompt: 42 });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_PROMPT');
});

test('POST /api/generate rejects prompts that are too long', async () => {
  const response = await postGenerate({ prompt: 'a'.repeat(4001) });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'PROMPT_TOO_LONG');
});

test('POST /api/generate returns 503 when the API key is not configured', async () => {
  const response = await postGenerate({ prompt: 'Hello Gemini' });
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.error.code, 'AI_NOT_CONFIGURED');
});

test('POST /api/generate accepts valid template and depth options', async () => {
  const response = await postGenerate({
    prompt: 'Write a small function',
    template: 'code',
    responseMode: 'detailed',
  });
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.error.code, 'AI_NOT_CONFIGURED');
});

test('POST /api/generate rejects an unknown template', async () => {
  const response = await postGenerate({ prompt: 'Hello', template: 'poetry' });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_TEMPLATE');
});

test('POST /api/generate rejects an unknown response depth', async () => {
  const response = await postGenerate({ prompt: 'Hello', responseMode: 'ultra' });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_RESPONSE_MODE');
});

test('POST /api/generate-image rejects an empty prompt', async () => {
  const response = await postImage({ prompt: '  ' });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'EMPTY_PROMPT');
});

test('POST /api/generate-image enforces the image prompt limit', async () => {
  const response = await postImage({ prompt: 'a'.repeat(1001) });
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'PROMPT_TOO_LONG');
  assert.match(body.error.message, /1,000/);
});

test('POST /api/generate-image returns 503 when the API key is not configured', async () => {
  const response = await postImage({ prompt: 'A lighthouse in fog' });
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.error.code, 'AI_NOT_CONFIGURED');
});

test('POST /api/image remains available as an alias', async () => {
  const response = await fetch(`${BASE_URL}/api/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'A lighthouse in fog' }),
  });
  assert.equal(response.status, 503);

  const body = await response.json();
  assert.equal(body.error.code, 'AI_NOT_CONFIGURED');
});

test('POST /api/generate rejects malformed JSON', async () => {
  const response = await postGenerate('{ "prompt": ');
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('oversized request bodies are rejected', async () => {
  const response = await postGenerate({ prompt: 'a'.repeat(20_000) });
  assert.equal(response.status, 413);

  const body = await response.json();
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
});

test('unknown endpoints return a JSON 404', async () => {
  const response = await fetch(`${BASE_URL}/api/does-not-exist`);
  assert.equal(response.status, 404);

  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('CORS allows Chrome extension origins', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const response = await fetch(`${BASE_URL}/api/health`, {
    headers: { Origin: origin },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
});

test('CORS allows explicitly configured origins', async () => {
  const response = await fetch(`${BASE_URL}/api/health`, {
    headers: { Origin: 'http://localhost:5173' },
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    'http://localhost:5173',
  );
});

test('requests from unapproved origins are rejected', async () => {
  const response = await postGenerate(
    { prompt: 'Hello' },
    { Origin: 'https://example.com' },
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error.code, 'FORBIDDEN_ORIGIN');
});

test('CORS preflight succeeds for allowed extension origins', async () => {
  const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const response = await fetch(`${BASE_URL}/api/generate`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
});
