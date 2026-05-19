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
import { chromium } from "playwright-core";

/** Skip reason when the OAuth fixture failed to load (creds missing from .env.integration). */
export const OAUTH_FIXTURE_NOT_LOADED_REASON =
  "requires an OAuth connection in test-fixtures/yaml_configs/integration-oauth.yaml";

/** Skip reason when the CCloud user creds for playwright-driven Auth0 sign-in are absent. */
export const OAUTH_USER_CREDS_MISSING_REASON =
  "requires CONFLUENT_CLOUD_USERNAME + CONFLUENT_CLOUD_PASSWORD for playwright-driven Auth0 sign-in";

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
  // attach the stderr listener synchronously so a fast log line emitted before our first await
  // isn't lost
  const authUrlPromise = waitForAuthUrl(server.stderr);
  const authUrl = await authUrlPromise;

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
    await page.waitForURL(/127\.0\.0\.1/, {
      waitUntil: "networkidle",
      timeout: CALLBACK_REDIRECT_TIMEOUT_MS,
    });
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
  const flowPromise = driveOAuthFlow(server, credentials);
  const callPromise = server.client.callTool(toolCall);
  const [, result] = await Promise.all([flowPromise, callPromise]);
  return result;
}

/** Reads pino JSON log lines from stderr, resolves with the `authUrl` field once the
 * `Opening Auth0 authorization URL` line appears. Detaches the listener on resolve/reject. */
function waitForAuthUrl(
  stderr: NodeJS.ReadableStream,
  timeoutMs = WAIT_FOR_AUTH_URL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      stderr.off("data", onData);
      clearTimeout(timer);
    };
    const onData = (chunk: Buffer | string) => {
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
      cleanup();
      reject(
        new Error(
          `did not see ${AUTH_URL_LOG_MSG} on server stderr within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    stderr.on("data", onData);
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
