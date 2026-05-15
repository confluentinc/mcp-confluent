// Playwright-driven PKCE driver: reads the Auth0 authorization URL from server stderr, drives
// the sign-in page via headless chromium, lets the server's PKCE callback resolve naturally.

import type { StartedServer } from "@tests/harness/start-server.js";

const AUTH_URL_LOG_MSG = "Opening Auth0 authorization URL";

const WAIT_FOR_AUTH_URL_TIMEOUT_MS = 30_000;
const CONSENT_BUTTON_TIMEOUT_MS = 5_000;
const CALLBACK_REDIRECT_TIMEOUT_MS = 30_000;

/** Drives PKCE end-to-end against the prod Auth0 tenant. Resolves once Auth0 has redirected to
 * the local callback URL; the server then exchanges the auth code for tokens. */
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
  // lazy chromium load so non-OAuth test files don't pay the import cost
  const { chromium } = await import("@playwright/test");
  const authUrl = await authUrlPromise;

  // unset MCP_INTEGRATION_TEST for one run to debug the flow visually
  const browser = await chromium.launch({
    headless: process.env.MCP_INTEGRATION_TEST === "1",
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
