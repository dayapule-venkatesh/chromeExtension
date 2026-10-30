import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3200;
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

  throw new Error(`Rate-limit test server did not start.\n${serverOutput}`);
}

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

function postGenerate(prompt) {
  return fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
}

function postImage(prompt) {
  return fetch(`${BASE_URL}/api/generate-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
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
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_IMAGE_MAX: '1',
      RATE_LIMIT_WINDOW_MS: '30000',
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

test('the rate limiter allows the configured number of requests', async () => {
  const response = await postGenerate('first request');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
});

test('the rate limiter reports a 30-second window', async () => {
  const response = await postGenerate('second request');
  assert.equal(response.status, 429);

  const body = await response.json();
  assert.equal(body.error.code, 'RATE_LIMITED');

  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter), 'Retry-After should be numeric');
  assert.ok(
    retryAfter >= 25 && retryAfter <= 30,
    `Expected a ~30-second window, got Retry-After=${retryAfter}`,
  );
});

test('image generation has its own rate-limit bucket', async () => {
  const first = await postImage('first image');
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('x-ratelimit-remaining'), '0');

  const second = await postImage('second image');
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'RATE_LIMITED');
});
