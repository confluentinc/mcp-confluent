// Playwright-driven CCloud OAuth driver: reads the Auth0 authorization URL from server stderr,
// drives the sign-in page via headless chromium, lets the server's OAuth callback resolve naturally.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { TransportType } from "@src/mcp/transports/types.js";
import {
  acquireOAuthPortLock,
  releaseOAuthPortLock,
} from "@tests/harness/oauth-port-lock.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { chromium, type Page } from "playwright-core";

/** Skip reason when the OAuth fixture failed to load (creds missing from .env.integration). */
export const OAUTH_FIXTURE_NOT_LOADED_REASON =
  "requires an OAuth connection in test-fixtures/yaml_configs/integration-oauth.yaml";

/** Skip reason when the CCloud user creds for playwright-driven Auth0 sign-in are absent. */
export const OAUTH_USER_CREDS_MISSING_REASON =
  "requires CONFLUENT_CLOUD_USERNAME + CONFLUENT_CLOUD_PASSWORD for playwright-driven Auth0 sign-in";

/**
 * Skip reason for an OAuth describe that relies on direct-fixture-backed test-side seeding or
 * verification helpers (admin/SR clients, env-id discovery). The MCP server under test is
 * OAuth-authed, but the test harness still needs to create the resource the tool acts on (or
 * verify the broker/SR state after the tool runs), and those helpers read api-key creds out of
 * `integration.yaml`. An OAuth-only CI lane that lacks the direct fixture creds should skip
 * cleanly via this gate rather than crash inside a `beforeAll`. Pair with the predicate-against-
 * direct-runtime check shown in the OAuth describe of any test that seeds.
 */
export const DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON =
  "OAuth describe uses direct-fixture-backed test-side seeding/verification helpers; missing required block in test-fixtures/yaml_configs/integration.yaml";

/**
 * Returns CCloud user creds from process.env, or `undefined` if either var is
 * missing. Callers pair this with an `it.skip(OAUTH_USER_CREDS_MISSING_REASON)`
 * + return early when the result is `undefined`.
 */
export function getOAuthCredentialsFromEnv():
  | { email: string; password: string }
  | undefined {
  const email = process.env.CONFLUENT_CLOUD_USERNAME;
  const password = process.env.CONFLUENT_CLOUD_PASSWORD;
  if (!email || !password) return undefined;
  return { email, password };
}

/**
 * Acquires the OAuth callback-port lock, then spawns the server with
 * `oauth: true`. Pair with {@linkcode stopOAuthServer} in `afterAll`.
 */
export async function startOAuthServer({
  transport,
}: {
  transport: TransportType;
}): Promise<StartedServer> {
  await acquireOAuthPortLock();
  return await startServer({ transport, oauth: true });
}

/**
 * Stops the server and releases the OAuth callback-port lock. Safe on
 * `undefined`; the lock release still runs.
 */
export async function stopOAuthServer(
  server: StartedServer | undefined,
): Promise<void> {
  try {
    await server?.stop();
  } finally {
    releaseOAuthPortLock();
  }
}

const AUTH_URL_LOG_MSG = "Opening Auth0 authorization URL";

const WAIT_FOR_AUTH_URL_TIMEOUT_MS = 30_000;
const CONSENT_BUTTON_TIMEOUT_MS = 5_000;
const CALLBACK_REDIRECT_TIMEOUT_MS = 30_000;

/** Drives the CCloud OAuth flow end-to-end against the prod Auth0 tenant. Resolves once Auth0
 * has redirected to the local callback URL; the server then exchanges the auth code for tokens. */
export async function driveOAuthFlow(
  server: StartedServer,
  credentials: { email: string; password: string },
): Promise<void> {
  if (!server.stderr) {
    throw new Error(
      "driveOAuthFlow requires startServer({ oauth: true }) so child stderr is piped",
    );
  }
  const authUrl = await waitForAuthUrl(server);

  const browser = await chromium.launch({
    // set INTEGRATION_TEST_PLAYWRIGHT_HEADLESS=false to watch the CCloud OAuth flow in a browser for debugging
    headless: process.env.INTEGRATION_TEST_PLAYWRIGHT_HEADLESS !== "false",
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(authUrl);
    // Auth0's email-then-password flow: one form per page, both submitted via [type=submit]
    await page
      .locator("[name=email], [name=username]")
      .first()
      .fill(credentials.email);
    await page.locator("[type=submit]").first().click();
    await page.locator("[name=password]").first().fill(credentials.password);
    await page.locator("[type=submit]").first().click();
    // optional consent page ("Authorize App: mcp-confluent..."). present the first time a user
    // authorizes this Auth0 client; absent on subsequent runs in the same Auth0 session.
    const consentButton = page.getByRole("button", {
      name: /accept|authorize|allow/i,
    });
    const consentVisible = await consentButton
      .first()
      .isVisible({ timeout: CONSENT_BUTTON_TIMEOUT_MS })
      .catch(() => false);
    if (consentVisible) {
      await consentButton.first().click();
    }
    try {
      await page.waitForURL(/127\.0\.0\.1/, {
        // `load` stalls on the success page's external favicon under restricted CI egress, and
        // `networkidle` never fires because the page holds an open EventSource (and is discouraged
        // in playwright docs; see https://playwright.dev/docs/api/class-page#page-wait-for-url)
        waitUntil: "domcontentloaded",
        timeout: CALLBACK_REDIRECT_TIMEOUT_MS,
      });
    } catch (error) {
      // capture where Auth0 actually landed so the next CI failure surfaces an anomaly screen,
      // captcha, password-rotation prompt, etc. instead of a generic playwright timeout
      throw await augmentCallbackTimeout(server, page, error);
    }
  } finally {
    await browser.close();
  }
}

type CallToolArgs = Parameters<Client["callTool"]>[0];
type CallToolResponse = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Drives the CCloud OAuth flow concurrently with a tool call that triggers it.
 * The server only starts the flow when an OAuth-eligible tool is invoked, so
 * {@linkcode driveOAuthFlow} completes the sign-in while the tool call waits
 * for the resulting bearer token. Returns the tool result.
 */
export async function callToolWithOAuthFlow(
  server: StartedServer,
  credentials: { email: string; password: string },
  toolCall: CallToolArgs,
): Promise<CallToolResponse> {
  // TEMPORARY INSTRUMENTATION: tag each step with a timestamp so we can correlate test-side
  // ordering with server-side "tool handler invoked" + "Starting OAuth login" log lines.
  // Diagnosing the ~30s gap between expected listener attach and observed URL emission.
  const tEntry = Date.now();
  process.stderr.write(
    `[OAUTH-TIMING] callToolWithOAuthFlow entry t=${tEntry} toolName=${toolCall.name}\n`,
  );
  const flowPromise = driveOAuthFlow(server, credentials);
  const tFlow = Date.now();
  process.stderr.write(
    `[OAUTH-TIMING] driveOAuthFlow returned promise t=${tFlow} (Δ=${tFlow - tEntry}ms)\n`,
  );
  const callPromise = server.client.callTool(toolCall);
  const tCall = Date.now();
  process.stderr.write(
    `[OAUTH-TIMING] callTool returned promise t=${tCall} (Δ=${tCall - tFlow}ms)\n`,
  );
  const [, result] = await Promise.all([flowPromise, callPromise]);
  process.stderr.write(
    `[OAUTH-TIMING] callToolWithOAuthFlow resolved t=${Date.now()} (totalΔ=${Date.now() - tEntry}ms)\n`,
  );
  return result;
}

/**
 * Resolves with the `authUrl` field of the first pino line matching `Opening Auth0 authorization
 * URL`. Races three sources so a stuck OAuth flow surfaces a useful error instead of a generic
 * 30s timeout: (1) the URL appears on stderr, (2) the child exits before emitting it, (3) the
 * timeout elapses. The exit and timeout paths both dump {@link StartedServer.stderrSnapshot}
 * so the failure message names what the server actually said.
 */
function waitForAuthUrl(
  server: StartedServer,
  timeoutMs = WAIT_FOR_AUTH_URL_TIMEOUT_MS,
): Promise<string> {
  const stderr = server.stderr;
  if (!stderr) {
    return Promise.reject(
      new Error(
        "waitForAuthUrl requires startServer({ oauth: true }) so child stderr is piped",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let firstDataT: number | undefined;
    let dataChunks = 0;
    const cleanup = () => {
      settled = true;
      stderr.off("data", onData);
      clearTimeout(timer);
    };
    const onData = (chunk: Buffer | string) => {
      dataChunks += 1;
      firstDataT ??= Date.now();
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const url = extractAuthUrl(line);
        if (url) {
          cleanup();
          resolve(url);
          return;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      // TEMPORARY INSTRUMENTATION: include listener-attach time, timeout-fire time, and a count
      // of data chunks received in the window. If `dataChunks=0` we know stderr was completely
      // silent for the listener's lifetime; if `firstDataT` is set but no URL matched, we know
      // data flowed but nothing matched the AUTH_URL_LOG_MSG line.
      reject(
        new Error(
          `did not see ${AUTH_URL_LOG_MSG} on server stderr within ${timeoutMs}ms.\n` +
            `Listener attached: ${listenerAttachT}\n` +
            `Timeout fired:    ${Date.now()}\n` +
            `Data chunks seen: ${dataChunks} (first at ${firstDataT ?? "never"})\n` +
            `Captured stderr:\n${server.stderrSnapshot?.() ?? "(stderrSnapshot unavailable - non-OAuth spawn?)"}`,
        ),
      );
    }, timeoutMs);
    const listenerAttachT = Date.now();
    process.stderr.write(
      `[OAUTH-TIMING] waitForAuthUrl listener attached t=${listenerAttachT}\n`,
    );
    stderr.on("data", onData);
    // race against child exit so a server that dies during OAuth init fails fast with the exit
    // code instead of waiting out the full timeout
    server.childExit?.then(({ code, signal }) => {
      if (settled) return;
      cleanup();
      reject(
        new Error(
          `server exited (code=${code}, signal=${signal ?? "null"}) before emitting ${AUTH_URL_LOG_MSG}.\n` +
            `Captured stderr:\n${server.stderrSnapshot?.() ?? "(no snapshot)"}`,
        ),
      );
    });
  });
}

function extractAuthUrl(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.msg !== AUTH_URL_LOG_MSG) return undefined;
  return typeof record.authUrl === "string" ? record.authUrl : undefined;
}

/** Body-excerpt cap when dumping the page after a callback-redirect timeout. */
const PAGE_BODY_EXCERPT_BYTES = 800;

/**
 * Enriches a `page.waitForURL` timeout with the URL/title/body excerpt of wherever Auth0 actually
 * landed, plus the server's stderr snapshot. Wraps the original error as `cause` so the stack is
 * preserved. Each capture step is best-effort: if the page is in an unusual state we skip the
 * field rather than masking the original timeout with a secondary failure.
 */
async function augmentCallbackTimeout(
  server: StartedServer,
  page: Page,
  cause: unknown,
): Promise<Error> {
  const url = await Promise.resolve(page.url()).catch(
    () => "(could not read page url)",
  );
  const title = await page.title().catch(() => "(could not read page title)");
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 1_000 })
    .then((text: string) => text.slice(0, PAGE_BODY_EXCERPT_BYTES))
    .catch(() => "(could not read page body)");
  const stderr = server.stderrSnapshot?.() ?? "(no snapshot)";
  return new Error(
    `OAuth callback redirect timed out after ${CALLBACK_REDIRECT_TIMEOUT_MS}ms. Auth0 stayed on:\n` +
      `  url:   ${url}\n` +
      `  title: ${title}\n` +
      `  body:  ${bodyText.replace(/\n/g, " ")}\n` +
      `Captured stderr:\n${stderr}`,
    { cause },
  );
}
