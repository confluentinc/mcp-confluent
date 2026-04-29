import { nodeHttp, nodeOpen } from "@src/confluent/node-deps.js";
import {
  OAUTH_CALLBACK_HOST,
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
} from "@src/confluent/oauth/auth0-config.js";
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
import { logger } from "@src/logger.js";

/** Maximum time to wait for the user to complete the browser PKCE flow. */
export const PKCE_LOGIN_TIMEOUT_MS = 120_000;

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

  const server = nodeHttp.createServer((req, res) => {
    const reqUrl = req.url ?? "";
    const parsed = new URL(reqUrl, "http://127.0.0.1");
    if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const receivedState = parsed.searchParams.get("state");
    if (receivedState !== state) {
      res.writeHead(400);
      res.end("State mismatch");
      return;
    }
    const errorParam = parsed.searchParams.get("error");
    if (errorParam) {
      res.writeHead(400);
      res.end("Authentication failed");
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
      res.writeHead(400);
      res.end("Missing code");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "Login successful. You can close this window and return to the terminal.",
    );
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

  let authCode: string;
  try {
    await bindResult;
    try {
      await nodeOpen.open(
        buildAuthorizationUrl(auth0Config, codeChallenge, state),
      );
    } catch (err) {
      throw new PkceLoginError(
        "configuration",
        `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new PkceLoginError("user_aborted", "PKCE login aborted"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => reject(new PkceLoginError("user_aborted", "PKCE login aborted")),
        { once: true },
      );
    });
    authCode = await Promise.race([codePromise, timeoutPromise, abortPromise]);
  } finally {
    clearTimeout(timer);
    if (bound) server.close();
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
