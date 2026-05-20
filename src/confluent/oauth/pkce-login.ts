import type { ServerResponse } from "node:http";

import { nodeHttp, nodeOpen } from "@src/confluent/node-deps.js";
import {
  OAUTH_CALLBACK_HOST,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
} from "@src/confluent/oauth/auth0-config.js";
import {
  renderErrorPage,
  renderSuccessPage,
} from "@src/confluent/oauth/callback-pages.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateOpaqueToken,
} from "@src/confluent/oauth/crypto-utils.js";
import {
  executeFullTokenChain,
  type TokenChainResult,
} from "@src/confluent/oauth/token-chain.js";
import type { Auth0Config } from "@src/confluent/oauth/types.js";
import { TelemetryEvent, TelemetryService } from "@src/confluent/telemetry.js";
import { logger } from "@src/logger.js";

/** Maximum time to wait for the user to complete the browser PKCE flow. */
export const PKCE_LOGIN_TIMEOUT_MS = 120_000;

/** Path the success page beacons to when the user copies the install hint. */
export const SKILLS_HINT_COPIED_PATH = "/skills-hint-copied";

/**
 * Grace period to keep the callback server listening after a successful auth
 * so the browser's "install hint copied" beacon can land. Short — telemetry
 * is best-effort and we don't want to delay shutdown noticeably.
 */
export const SKILLS_HINT_BEACON_GRACE_MS = 5_000;

/** Reasons a PKCE login can fail. Carried on {@link PkceLoginError}. */
export type PkceLoginFailureReason =
  | "timeout"
  | "user_aborted"
  | "port_in_use"
  | "auth0_unreachable"
  | "configuration";

/** Structured error so callers can react to the cause of a failed PKCE login. */
export class PkceLoginError extends Error {
  constructor(
    public readonly reason: PkceLoginFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "PkceLoginError";
  }
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=UTF-8" });
  res.end(body);
}

function buildAuthorizationUrl(
  auth0Config: Auth0Config,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: auth0Config.clientId,
    response_type: "code",
    redirect_uri: auth0Config.callbackUrl,
    scope: auth0Config.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `https://${auth0Config.domain}/authorize?${params.toString()}`;
}

/**
 * Runs the PKCE flow end-to-end:
 *  - generates verifier / challenge / state
 *  - binds a one-shot HTTP listener on {@link OAUTH_CALLBACK_PORT}
 *  - opens the browser to the Auth0 authorization endpoint
 *  - waits for the redirect carrying the auth code
 *  - exchanges the code for the full Confluent token chain
 *
 * Bounded by {@link PKCE_LOGIN_TIMEOUT_MS}. Throws {@link PkceLoginError} on
 * failure with a structured `reason`. If `signal` aborts before the auth
 * code arrives, throws `PkceLoginError("user_aborted", ...)` and the finally
 * block tears down the timer + HTTP server.
 */
export async function runPkceLogin(
  auth0Config: Auth0Config,
  signal?: AbortSignal,
): Promise<TokenChainResult> {
  // Early abort: skip the bind/open work entirely if the caller has already
  // signaled cancellation.
  if (signal?.aborted) {
    throw new PkceLoginError("user_aborted", "PKCE login aborted");
  }
  if (!auth0Config.clientId) {
    throw new PkceLoginError(
      "configuration",
      "Auth0 clientId is not configured for the selected environment",
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateOpaqueToken();

  let resolveCode: (code: string) => void = () => undefined;
  let rejectFlow: (err: PkceLoginError) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectFlow = reject;
  });

  // Tracks whether the success page was served. The finally block reads this
  // to defer server.close() so the page's "install hint copied" beacon can
  // land before the listener tears down.
  let successServed = false;
  let beaconCloseTimer: ReturnType<typeof setTimeout> | undefined;

  const server = nodeHttp.createServer((req, res) => {
    const reqUrl = req.url ?? "";
    const parsed = new URL(reqUrl, "http://127.0.0.1");
    if (parsed.pathname === SKILLS_HINT_COPIED_PATH) {
      try {
        TelemetryService.getInstance().track(
          TelemetryEvent.AGENT_SKILLS_HINT_COPIED,
          {},
        );
      } catch (err) {
        logger.warn({ err }, "Failed to track agent-skills hint copied event");
      }
      res.writeHead(204);
      res.end();
      if (beaconCloseTimer) {
        clearTimeout(beaconCloseTimer);
        beaconCloseTimer = undefined;
        if (bound) server.close();
      }
      return;
    }
    if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
      sendHtml(res, 404, renderErrorPage("Not found"));
      return;
    }
    const receivedState = parsed.searchParams.get("state");
    if (receivedState !== state) {
      sendHtml(res, 400, renderErrorPage("State mismatch"));
      return;
    }
    const errorParam = parsed.searchParams.get("error");
    if (errorParam) {
      sendHtml(
        res,
        400,
        renderErrorPage(`Authentication failed: ${errorParam}`),
      );
      rejectFlow(
        new PkceLoginError(
          "user_aborted",
          `Auth0 redirect carried error=${errorParam}`,
        ),
      );
      return;
    }
    const code = parsed.searchParams.get("code");
    if (!code) {
      sendHtml(res, 400, renderErrorPage("Missing authorization code"));
      return;
    }
    sendHtml(res, 200, renderSuccessPage());
    successServed = true;
    resolveCode(code);
  });

  let bound = false;
  const bindResult = new Promise<void>((resolve, reject) => {
    const onBindError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new PkceLoginError(
            "port_in_use",
            `Port ${OAUTH_CALLBACK_PORT} is already in use; another mcp-confluent OAuth session may be active`,
          ),
        );
      } else {
        reject(
          new PkceLoginError(
            "configuration",
            `Failed to bind PKCE callback server on ${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}: ${err.message}`,
          ),
        );
      }
    };
    server.on("error", onBindError);
    server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, () => {
      bound = true;
      server.off("error", onBindError);
      // Replace the bind-time rejector with a log-only listener so a stray
      // post-bind socket error doesn't escape as an uncaught 'error' event.
      server.on("error", (err) => {
        logger.warn({ err }, "PKCE callback server post-bind error");
      });
      resolve();
    });
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new PkceLoginError(
          "timeout",
          `PKCE login timed out after ${PKCE_LOGIN_TIMEOUT_MS}ms`,
        ),
      );
    }, PKCE_LOGIN_TIMEOUT_MS);
  });

  // One abortPromise + listener races every long-lived await below, so a
  // cancellation observed during bind/open also unblocks promptly.
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () =>
      reject(new PkceLoginError("user_aborted", "PKCE login aborted"));
    signal?.addEventListener("abort", abortListener, { once: true });
  });

  let authCode: string;
  try {
    await Promise.race([bindResult, abortPromise]);
    const authUrl = buildAuthorizationUrl(auth0Config, codeChallenge, state);
    // log the URL so users whose default browser misbehaves can open it manually. safe to log:
    // the URL carries only the one-time PKCE code_challenge + state, both bound to this single
    // login attempt and discarded once the callback resolves.
    logger.info({ authUrl }, "Opening Auth0 authorization URL");
    try {
      await Promise.race([nodeOpen.open(authUrl), abortPromise]);
    } catch (err) {
      // Preserve user_aborted from the race; wrap any other open() failure.
      if (err instanceof PkceLoginError) throw err;
      throw new PkceLoginError(
        "configuration",
        `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    authCode = await Promise.race([codePromise, timeoutPromise, abortPromise]);
  } finally {
    // Remove the abort listener if the race resolved via something other
    // than abort, so we don't leak a listener on a long-lived AbortSignal.
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    clearTimeout(timer);
    if (bound) {
      if (successServed) {
        // Keep the listener alive briefly so the success page's "install hint
        // copied" beacon can land. The beacon handler also clears this timer
        // and closes the server immediately when it arrives.
        beaconCloseTimer = setTimeout(() => {
          beaconCloseTimer = undefined;
          server.close();
        }, SKILLS_HINT_BEACON_GRACE_MS);
        beaconCloseTimer.unref?.();
      } else {
        server.close();
      }
    }
  }

  logger.info("PKCE auth code received; exchanging for token chain");
  try {
    return await executeFullTokenChain(auth0Config, authCode, codeVerifier);
  } catch (err) {
    throw new PkceLoginError(
      "auth0_unreachable",
      `Token chain failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
