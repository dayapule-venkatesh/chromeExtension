# Gemini AI Chrome Extension

A working, end-to-end Chrome extension that sends prompts to Google Gemini through a small Node.js/Express backend. The Gemini API key is stored **only** in the backend `.env` file and is never shipped in the extension.

![Popup preview](docs/popup-preview.png)

## Features

- Clean Manifest V3 popup built with HTML, CSS, and vanilla JavaScript
- Prompt validation, loading state, error handling, and duplicate-request prevention
- **Light / dark / system theme toggle** with a one-click cycle; the choice is remembered
- **Text and image generation modes** — switch between chat answers and generated pictures
- **Response templates** (Default, Detailed, Concise, ELI5, Technical, Creative, Deep explanation, Bullet summary)
- **Response-speed presets** — Slow (most detailed), Medium (balanced), Fast (brief)
- **Quick actions** — one-click Explain / Summarize / Rewrite wrappers for any text
- **Download responses** — text answers as `.txt`, generated images as `.png`
- Response rendered strictly as text (no `innerHTML`), preventing XSS from model output
- Copy-to-clipboard, `Ctrl`/`Cmd` + `Enter` shortcut, reduced-motion support
- Express backend with:
  - `GET /api/health` health check
  - `POST /api/generate` Gemini text proxy with template and speed options
  - `POST /api/image` Gemini image generation
  - Request validation and size limits
  - Per-IP rate limiting (in memory; tighter limit for image generation)
  - CORS restricted to Chrome extension origins plus an optional allowlist
  - Automatic retry for temporary Gemini 5xx errors
  - Timeouts and safe, non-leaking error responses
- Uses the official [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK and the Gemini Interactions API
- Gemini requests use `store: false`, so conversation state is not retained by the Interactions API
- No frontend build step and no unnecessary runtime dependencies

## Project structure

```text
AI-Chrome-Extension/
├── extension/
│   ├── manifest.json        # Manifest V3 configuration
│   ├── popup.html           # Popup markup
│   ├── popup.css            # Popup styling (light + dark)
│   ├── popup.js             # Client logic and backend requests
│   └── icons/               # Toolbar icons
├── backend/
│   ├── server.js            # Express server + Gemini integration
│   ├── package.json
│   ├── package-lock.json
│   ├── .env                 # Your local secrets (not committed)
│   ├── .env.example         # Configuration template
│   ├── test/smoke.test.js   # Backend API tests (node:test)
│   └── test/rate-limit.test.js
├── docs/
│   └── popup-preview.png
├── .gitignore
└── README.md
```

## Prerequisites

- **Node.js 20 or newer** (tested with Node.js 24.21.0 and npm 11.19.0)
- **Google Chrome** (any recent version with Manifest V3 support)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey)

## 1. Configure and start the backend

```bash
cd AI-Chrome-Extension/backend
npm install
```

Open `backend/.env` and replace the placeholder key:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

The file already contains sensible defaults:

```env
PORT=3000
HOST=127.0.0.1
GEMINI_MODEL=gemini-3.6-flash
MAX_PROMPT_LENGTH=4000
REQUEST_TIMEOUT_MS=60000
GEMINI_MAX_ATTEMPTS=2
RATE_LIMIT_MAX=15
ALLOWED_ORIGINS=
```

Start the server:

```bash
npm start
```

You should see:

```text
Backend listening on http://127.0.0.1:3000
Health check: http://127.0.0.1:3000/api/health
Gemini model: gemini-3.6-flash
```

Verify the health endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "ai-chrome-extension-backend",
  "timestamp": "2026-10-30T07:22:01.462Z"
}
```

For development with automatic restarts:

```bash
npm run dev
```

> **Note:** If the server starts without an API key, `/api/health` still works and `/api/generate` returns `503 AI_NOT_CONFIGURED`. This is intentional so the server remains diagnosable during setup.

## 2. Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select the `AI-Chrome-Extension/extension` folder.
5. Pin **Gemini AI Assistant** if desired, then click its toolbar icon.

The extension is allowed to call `http://127.0.0.1:3000/*` and `http://localhost:3000/*` through `host_permissions`. It requests no other Chrome permissions.

## 3. Use it

1. Make sure the backend is running.
2. Open the extension popup.
3. Enter a prompt.
4. Click **Generate** (or press `Ctrl`/`Cmd` + `Enter`).
5. Read the response, or click **Copy** to copy it.

## API reference

### `GET /api/health`

Returns the server status.

**Response — `200 OK`**

```json
{
  "status": "ok",
  "service": "ai-chrome-extension-backend",
  "timestamp": "2026-10-30T07:22:01.462Z"
}
```

### `POST /api/generate`

**Request**

```json
{
  "prompt": "Explain quantum computing in one sentence.",
  "template": "default",
  "responseMode": "medium"
}
```

`template` (optional): `default`, `detailed`, `concise`, `eli5`, `technical`, `creative`, `explain`, `summarize`
`responseMode` (optional): `slow` (most detailed), `medium` (balanced), `fast` (brief). Unknown values quietly fall back to the defaults.

**Success — `200 OK`**

```json
{
  "response": "Quantum computing uses quantum bits that can exist in multiple states at once, allowing certain calculations to be performed far more efficiently than with classical bits.",
  "model": "gemini-3.6-flash"
}
```

**Errors**

```json
{
  "error": {
    "code": "EMPTY_PROMPT",
    "message": "Please enter a prompt before generating."
  }
}
```

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `INVALID_PROMPT`, `EMPTY_PROMPT`, `PROMPT_TOO_LONG` | Invalid request body or prompt |
| `400` | `INVALID_JSON` | Malformed JSON body |
| `403` | `FORBIDDEN_ORIGIN` | Browser origin not allowed by CORS policy |
| `413` | `PAYLOAD_TOO_LARGE` | Request body exceeds 16 KB |
| `429` | `RATE_LIMITED`, `AI_RATE_LIMITED` | Local or Gemini rate limit reached |
| `502` | `AI_AUTH_ERROR`, `AI_REQUEST_REJECTED`, `AI_SERVICE_ERROR`, `EMPTY_AI_RESPONSE` | Upstream Gemini failure |
| `503` | `AI_NOT_CONFIGURED`, `AI_UNAVAILABLE` | Missing/placeholder key, or Gemini is experiencing high demand |
| `504` | `AI_TIMEOUT` | Gemini did not respond within the timeout |
| `500` | `INTERNAL_ERROR` | Unexpected server failure |

Error responses never include API keys, stack traces, or other internal details. Full details are logged on the server only.

### `POST /api/image`

Generates an image with Gemini and returns it as a base64 data URL.

**Request**

```json
{
  "prompt": "A watercolor fox in a misty forest, soft light"
}
```

**Success — `200 OK`**

```json
{
  "image": "data:image/png;base64,iVBORw0KGgo...",
  "model": "gemini-2.5-flash-image"
}
```

Image prompts are limited to the value of `IMAGE_MAX_PROMPT_LENGTH` (default 1,000 characters) and share the same error codes as `/api/generate`, with their own, stricter rate limit.

## Configuration

All backend settings live in `backend/.env`:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; loopback-only by default |
| `GEMINI_API_KEY` | — | **Required.** Gemini API key |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Supported Gemini model name |
| `GEMINI_IMAGE_MODEL` | `gemini-2.5-flash-image` | Gemini model used by `/api/image` |
| `MAX_PROMPT_LENGTH` | `4000` | Maximum text prompt length in characters |
| `IMAGE_MAX_PROMPT_LENGTH` | `1000` | Maximum image prompt length in characters |
| `REQUEST_TIMEOUT_MS` | `60000` | Total Gemini time budget in milliseconds, shared across retries; keep this below the extension's 70-second client timeout |
| `GEMINI_MAX_ATTEMPTS` | `2` | Attempts for transient Gemini 5xx errors (2 = one automatic retry) |
| `RATE_LIMIT_MAX` | `15` | Text requests per IP per `RATE_LIMIT_WINDOW_MS` window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `RATE_LIMIT_IMAGE_MAX` | `6` | Image requests per IP per window |
| `ALLOWED_ORIGINS` | empty | Comma-separated extra CORS origins (for example `http://localhost:5173`) |

The extension defaults to `gemini-3.6-flash`, verified with a live generation through the Interactions API provided by `@google/genai` 2.32.0. `gemini-3.8-flash` is also supported by the API but returned high-demand responses during testing; you can select it with `GEMINI_MODEL` when capacity is available. Availability of any model depends on your account and region.

If you change the backend port, update **both**:

- `API_URL` in `extension/popup.js`
- `host_permissions` in `extension/manifest.json`

## Security notes

- The API key exists only in `backend/.env`; it is never returned to clients or embedded in the extension.
- `.env` is ignored by Git; `.env.example` contains no secret.
- Prompts are validated as strings, trimmed, stripped of control characters, and limited to 4,000 characters. Request bodies are capped at 16 KB.
- Model output is inserted with `textContent`, so HTML/JavaScript in a response is displayed as text and not executed.
- CORS allows any `chrome-extension://` origin (unpacked extension IDs change) and any origin explicitly listed in `ALLOWED_ORIGINS`. Requests from other browser origins receive `403`.
- The backend binds to `127.0.0.1` by default and applies a per-IP rate limit.
- API errors are mapped to safe client messages; detailed errors are logged server-side with API keys redacted.
- The extension requests no Chrome API permissions; its only permission is network host access to the local backend.

**Do not expose this backend publicly as-is.** CORS is not authentication. Before deploying remotely, add authentication/authorization, TLS, a durable shared rate limiter, and secret management.

## Testing

Run the backend test suite:

```bash
cd backend
npm test
```

The suite uses Node's built-in test runner and covers:

- Health endpoint
- Empty, missing, non-string, and oversized prompts
- Missing API key (`503`)
- Malformed JSON and oversized request bodies
- JSON `404` handling
- CORS for Chrome extension origins, configured origins, disallowed origins, and preflight requests
- Local rate limiting and its 60-second window

All 15 tests pass.

The popup was also exercised inside Chrome against a mock backend and the real backend to verify:

- Extension loading and Manifest V3 configuration
- Empty-prompt validation
- Loading indicator, disabled button, and duplicate-submit prevention
- Successful response rendering
- XSS-safe text rendering (`<script>` payloads are displayed, not executed)
- Backend error, rate-limit, and network-failure messages
- Copy-to-clipboard and light/dark rendering
- Successful communication with the real Express backend (a safe `503` was verified without a key)
- A live end-to-end generation through the real backend and popup, rendered in the extension

A live generation was verified on 2026-10-30 with `gemini-3.6-flash` (about 2 seconds end to end). During testing, `gemini-3.8-flash` returned temporary high-demand and rate-limit responses from Gemini, so the project defaults to the verified `gemini-3.6-flash`. You can change `GEMINI_MODEL` in `.env` whenever another model has capacity. Use the manual request below to confirm generation in your own environment.

### Manual API check

```powershell
$body = @{ prompt = "Explain quantum computing in one sentence." } | ConvertTo-Json
Invoke-RestMethod `
  -Uri http://127.0.0.1:3000/api/generate `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Popup says **"Could not reach the backend"** | Start the backend with `npm start`; confirm it is on port 3000 and that the URL in `popup.js` matches. |
| `503 AI_NOT_CONFIGURED` | Replace the placeholder in `backend/.env` with a real Gemini key and restart the server. |
| `502 AI_AUTH_ERROR` or `AI_REQUEST_REJECTED` | Check that the API key is valid, the Gemini API is enabled for the project, and the model in `GEMINI_MODEL` is available in your region/account. |
| `429 AI_RATE_LIMITED` | Gemini quota or rate limit reached. Wait and retry, or check your plan in Google AI Studio. |
| `503 AI_UNAVAILABLE` / **Gemini high demand** | The backend retries transient 5xx responses once automatically. If demand persists, wait a minute and retry, or set `GEMINI_MODEL` to another model supported by your account in `.env` and restart the server. |
| `504 AI_TIMEOUT` | Gemini did not answer in time. Retry the prompt; for long prompts, try shorter input or switch to a lighter model. |
| `429 RATE_LIMITED` | More than 15 local requests per minute from one IP. Wait up to a minute. |
| `403 FORBIDDEN_ORIGIN` | Request came from a browser origin other than `chrome-extension://` or `ALLOWED_ORIGINS`. |
| Extension fails to load | Select the `extension` folder itself (the one containing `manifest.json`), not the project root. |
| Popup is blank after an update | Click **Reload** on `chrome://extensions/` and reopen the popup. |
| `Could not copy the response` | Click the copy button once more; clipboard writes require a user gesture. |

## License

This project is provided for educational and personal use.
