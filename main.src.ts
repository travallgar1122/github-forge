// main.src.ts — the forge's entrypoint, kept in readable form.
//
// This source was written to be packed into the entry by the kit's own
// `makefun compress`, and it was (the run is in the session). Verification
// then showed the makefun-compress/v1 stub is a Python entry — it cannot
// run under this competition's Node harness — so main.ts carries this
// same implementation directly, in the same words, instead of the stub
// (NOTES.md, block 8, has the evidence). What follows is the whole of
// the entry <-> env lifecycle, as the wire contract
// (program/env/src/wire.ts in the kit) settles it:
//
//   1. Build the forge with createApp() and bind an ephemeral port:
//      listen(0) lets the kernel pick one. A fixed port is never used,
//      and 8080 belongs to the env itself.
//   2. Announce the port: POST {"port": N} as JSON to
//      $MAKEFUN_ENV_URL/register. The env notes the address the request
//      arrived from and dials http://<that address>:N from then on.
//      The first register wins — a second is answered 409 and the base
//      URL does not move.
//   3. While the suite drives the forge, poll GET $MAKEFUN_ENV_URL/done.
//      The env answers at once, never holding the request open:
//      {"done": false} until the suite has finished and written its
//      export, then {"done": true}.
//   4. On {"done": true}, close the server and exit 0.
//
// Two failure postures matter. Registering is retried with backoff while
// the env is still coming up: a program that never registers inside the
// boot budget scores 0, so a refused or unreachable env is a reason to
// wait, never to exit. And the done poll treats a failed request exactly
// like a {"done": false} answer — the poll cadence (250 ms, doubling to
// a 2 s ceiling, each request capped at 30 s) is the contract's own.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** The environment variable the harness uses to hand us the env's origin. */
const ENV_URL_VAR = 'MAKEFUN_ENV_URL';
/** The first wait between register retries and done polls, in ms. */
const FIRST_WAIT_MS = 250;
/** The longest wait between retries and polls, in ms. */
const LONGEST_WAIT_MS = 2_000;
/** One done request is never held open longer than this, in ms. */
const DONE_REQUEST_TIMEOUT_MS = 30_000;
/** One register request gets this long before it counts as failed, in ms. */
const REGISTER_REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The wait after attempt `attempt` fails: 250 ms, doubling, capped at 2 s. */
function waitAfter(attempt: number): number {
  return Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** attempt);
}

/** Join a path onto the env origin, tolerating a trailing slash on the origin. */
function envUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, '')}${path}`;
}

/**
 * POST our port to the env until the register settles: 200 means the env
 * took this entry as the one it dials; 409 means a register already won
 * and there is nothing more to announce. Anything else — a refused
 * connection, a timeout, an unexpected status — is retried after a wait.
 */
async function announce(origin: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(envUrl(origin, '/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REGISTER_REQUEST_TIMEOUT_MS),
      });
      await reply.text().catch(() => '');
      if (reply.status === 200 || reply.status === 409) return;
    } catch {
      // The env may not be listening yet; the boot budget leaves room.
    }
    await sleep(waitAfter(attempt));
  }
}

/**
 * Poll GET /done until the env reports the suite is over. The body is
 * read as JSON and only a literal {"done": true} ends the wait; every
 * other outcome — false, a malformed body, a failed request — polls on.
 */
async function waitUntilDone(origin: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(envUrl(origin, '/done'), {
        signal: AbortSignal.timeout(DONE_REQUEST_TIMEOUT_MS),
      });
      if (reply.ok) {
        const body: unknown = await reply.json();
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
          return;
        }
      }
    } catch {
      // A failed poll is a "not yet" answer with a longer wait.
    }
    await sleep(waitAfter(attempt));
  }
}

async function run(): Promise<void> {
  const origin = process.env[ENV_URL_VAR];
  if (origin === undefined || origin === '') {
    console.error(`${ENV_URL_VAR} is not set: this entry runs beside the contest env, not on its own`);
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      resolve();
    });
  });
  const bound = server.address() as AddressInfo;

  await announce(origin, bound.port);
  await waitUntilDone(origin);

  // The suite is finished and its export is written; nothing is in
  // flight. Drop any keep-alive sockets so close() settles at once,
  // then end with the contract's exit code.
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  process.exit(0);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
