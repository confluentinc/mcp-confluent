import type { IncomingMessage, ServerResponse } from "node:http";

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

/** Path the success page POSTs to when the user copies the install hint. */
export const SKILLS_HINT_COPIED_PATH = "/skills-hint-copied";

/**
 * Path the success page opens an EventSource to. The open connection is what
 * keeps the callback server alive past the OAuth redirect: as long as the page
 * is in a tab, the stream is connected and beacons land on a live listener.
 * When the tab closes, the stream disconnects and the server tears down.
 */
export const SKILLS_HINT_STREAM_PATH = "/skills-hint-stream";

/**
 * Safety cap on how long the callback server can stay bound after a successful
 * auth. The stream-disconnect path is the normal closer; this is just the
 * "user left the tab open and walked away" backstop. Kept tight (60s) because
 * a lingering listener will collide with the next PKCE attempt — if a token
 * refresh fails non-transiently inside this window and triggers a fresh login,
 * the second attempt errors with `port_in_use` when in fact it's this same
 * session's leftover listener still holding the port.
 */
export const SUCCESS_PAGE_MAX_LIFETIME_MS = 60_000;

/** Reasons a PKCE login can fail. Carried on {@link PkceLoginError}. */
export type PkceLoginFailureReason =
  | "timeout"
  | "user_aborted"
  | "port_in_use"
  | "auth0_unreachable"
  | "callback_server_error"
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

type CallbackServer = ReturnType<typeof nodeHttp.createServer>;

/**
 * Mutable state shared across the PKCE callback server's request handlers,
 * threaded explicitly instead of closure capture so those handlers can live
 * as module-level functions (see the cognitive-complexity note on
 * {@link runPkceLogin}).
 */
interface PkceCallbackState {
  readonly oauthState: string;
  readonly streamClients: Set<ServerResponse>;
  readonly resolveCode: (code: string) => void;
  readonly rejectFlow: (err: PkceLoginError) => void;
  successServed: boolean;
  serverClosed: boolean;
  bound: boolean;
  lifetimeTimer?: ReturnType<typeof setTimeout>;
}

function closeServerOnce(server: CallbackServer, state: PkceCallbackState) {
  if (state.serverClosed || !state.bound) return;
  state.serverClosed = true;
  if (state.lifetimeTimer) {
    clearTimeout(state.lifetimeTimer);
    state.lifetimeTimer = undefined;
  }
  for (const client of state.streamClients) client.end();
  state.streamClients.clear();
  server.close();
}

function handleSkillsHintCopiedRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: PkceCallbackState,
): void {
  // Only reachable once we've served the success page. Anything earlier
  // would be a stray request on localhost, not a copy of the install hint.
  if (!state.successServed) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    res.end();
    return;
  }
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
}

function handleSkillsHintStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  server: CallbackServer,
  state: PkceCallbackState,
): void {
  // Same gate as the beacon: the stream only makes sense once the success
  // page has been served. Pre-auth requests get a 404.
  if (!state.successServed) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Flush headers so the browser considers the EventSource "open".
  res.write(": connected\n\n");
  state.streamClients.add(res);
  req.on("close", () => {
    state.streamClients.delete(res);
    // When the last tab closes and auth already succeeded, the listener
    // has no further reason to exist.
    if (state.successServed && state.streamClients.size === 0) {
      closeServerOnce(server, state);
    }
  });
}

function handleOAuthRedirectRequest(
  res: ServerResponse,
  parsed: URL,
  state: PkceCallbackState,
): void {
  const receivedState = parsed.searchParams.get("state");
  if (receivedState !== state.oauthState) {
    sendHtml(res, 400, renderErrorPage("State mismatch"));
    return;
  }
  const errorParam = parsed.searchParams.get("error");
  if (errorParam) {
    sendHtml(res, 400, renderErrorPage(`Authentication failed: ${errorParam}`));
    state.rejectFlow(
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
  sendHtml(
    res,
    200,
    renderSuccessPage({
      copiedPath: SKILLS_HINT_COPIED_PATH,
      streamPath: SKILLS_HINT_STREAM_PATH,
    }),
  );
  state.successServed = true;
  state.resolveCode(code);
}

function createCallbackRequestListener(
  server: CallbackServer,
  state: PkceCallbackState,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const parsed = new URL(req.url ?? "", "http://127.0.0.1");
    if (parsed.pathname === SKILLS_HINT_COPIED_PATH) {
      handleSkillsHintCopiedRequest(req, res, state);
      return;
    }
    if (parsed.pathname === SKILLS_HINT_STREAM_PATH) {
      handleSkillsHintStreamRequest(req, res, server, state);
      return;
    }
    if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
      sendHtml(res, 404, renderErrorPage("Not found"));
      return;
    }
    handleOAuthRedirectRequest(res, parsed, state);
  };
}

function bindCallbackServer(
  server: CallbackServer,
  state: PkceCallbackState,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
      state.bound = true;
      server.off("error", onBindError);
      // Post-bind socket errors must reject the in-flight flow, not just warn: if the listener
      // dies mid-callback (EMFILE, broken TLS upgrade, etc.) the user would otherwise hang on
      // `codePromise` until `PKCE_LOGIN_TIMEOUT_MS` (minutes) instead of failing fast.
      server.on("error", (err) => {
        logger.warn({ err }, "PKCE callback server post-bind error");
        state.rejectFlow(
          new PkceLoginError(
            "callback_server_error",
            `PKCE callback listener errored after bind: ${err.message}`,
          ),
        );
      });
      resolve();
    });
  });
}

async function openBrowserOrThrow(
  authUrl: string,
  abortPromise: Promise<never>,
): Promise<void> {
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
}

function teardownCallbackServer(
  server: CallbackServer,
  state: PkceCallbackState,
): void {
  if (!state.bound) return;
  if (state.successServed) {
    // The success page's EventSource keeps the listener alive while the
    // browser tab is open; stream-disconnect calls closeServerOnce. The
    // timer + unref'd server are the "tab left open" backstop so this
    // listener can never keep the process alive on its own.
    server.unref?.();
    state.lifetimeTimer = setTimeout(
      () => closeServerOnce(server, state),
      SUCCESS_PAGE_MAX_LIFETIME_MS,
    );
    state.lifetimeTimer.unref?.();
  } else {
    closeServerOnce(server, state);
  }
}

async function exchangeTokensOrThrow(
  auth0Config: Auth0Config,
  authCode: string,
  codeVerifier: string,
): Promise<TokenChainResult> {
  try {
    return await executeFullTokenChain(auth0Config, authCode, codeVerifier);
  } catch (err) {
    throw new PkceLoginError(
      "auth0_unreachable",
      `Token chain failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  const oauthState = generateOpaqueToken();

  let resolveCode: (code: string) => void = () => undefined;
  let rejectFlow: (err: PkceLoginError) => void = () => undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectFlow = reject;
  });

  // Tracks whether the success page was served. After success, the server's
  // lifetime is driven by the success page's EventSource: it stays bound while
  // the tab is open and closes when the stream disconnects (or when the safety
  // timer fires).
  const state: PkceCallbackState = {
    oauthState,
    streamClients: new Set<ServerResponse>(),
    resolveCode,
    rejectFlow,
    successServed: false,
    serverClosed: false,
    bound: false,
  };

  // `server` is referenced inside its own request listener (to close itself
  // once the success-page stream disconnects); the listener closure only
  // runs once a request arrives, well after this `const` is initialized.
  const server: CallbackServer = nodeHttp.createServer((req, res) =>
    createCallbackRequestListener(server, state)(req, res),
  );

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
    await Promise.race([bindCallbackServer(server, state), abortPromise]);
    const authUrl = buildAuthorizationUrl(
      auth0Config,
      codeChallenge,
      oauthState,
    );
    // log the URL so users whose default browser misbehaves can open it manually. safe to log:
    // the URL carries only the one-time PKCE code_challenge + state, both bound to this single
    // login attempt and discarded once the callback resolves.
    logger.info({ authUrl }, "Opening Auth0 authorization URL");
    await openBrowserOrThrow(authUrl, abortPromise);
    authCode = await Promise.race([codePromise, timeoutPromise, abortPromise]);
  } finally {
    // Remove the abort listener if the race resolved via something other
    // than abort, so we don't leak a listener on a long-lived AbortSignal.
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    clearTimeout(timer);
    teardownCallbackServer(server, state);
  }

  logger.info("PKCE auth code received; exchanging for token chain");
  return exchangeTokensOrThrow(auth0Config, authCode, codeVerifier);
}
