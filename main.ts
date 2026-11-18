// Entry point for the github-core-clone-01 forge.
//
// This file only runs the trial lifecycle. Everything the forge serves —
// git smart HTTP, the REST API, GraphQL, MCP — lives in app.ts. This file
// starts that server, tells the trial environment which port it picked,
// and then waits until the environment reports the trial is finished
// before shutting the server down and exiting.
//
// The environment exposes two endpoints for this:
//   POST <env>/register   with {"port": <bound port>}
//   GET  <env>/done       answering {"done": false} while the trial runs
//                         and {"done": true} once its export is written.
// Both calls are retried with backoff whenever the environment is still
// starting up. The process must never exit early: leaving before "done"
// would abandon the trial, and a trial with no forge scores nothing.

import { createApp } from './app.ts';

/** Trial environment origin, with any trailing slashes removed. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** First pause between retries; it doubles after each failure. */
const RETRY_START_MS = 250;
/** Longest pause between retries. */
const RETRY_CAP_MS = 2000;
/** How long one register or done request may run before it is retried. */
const REQUEST_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Backoff delay after `attempt` consecutive failures (0-based count). */
function backoffMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_START_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Announce the bound port to the environment. A 200 means it recorded
 * the port; a 409 means another entry registered first, which is not
 * this process's problem to fix, so it waits like any other entry.
 * A 400 or 405 means the request itself is malformed and the process
 * has to stop. Any other failure — network error, timeout, 5xx — is
 * retried, because the environment may still be booting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(
          `register rejected with HTTP ${res.status}: ${await res.text()}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register rejected')) {
        throw err;
      }
    }
    await sleep(backoffMs(attempt));
  }
}

/** Keep polling /done until the environment answers {"done": true}. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet; keep polling.
    }
    await sleep(backoffMs(attempt));
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    throw new Error(
      'MAKEFUN_ENV_URL is empty: no trial environment to register with',
    );
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  process.stdout.write(`[entry] forge up on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the trial to finish\n');

  await waitForDone();
  // Close the server, but do not hang on it: the suite may still hold
  // keep-alive connections, and the trial is already over, so a short
  // grace period is enough before exiting.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  process.stdout.write('[entry] trial finished; forge stopped\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
