import { nodeCrypto, nodeHttp, nodeOpen } from "@src/confluent/node-deps.js";
import {
  OAUTH_CALLBACK_PATH,
  OAUTH_CALLBACK_PORT,
} from "@src/confluent/oauth/auth0-config.js";
import {
  generateCodeChallenge,
  generateCodeVerifier,
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
 * failure with a structured `reason`.
 */
export async function runPkceLogin(
  auth0Config: Auth0Config,
): Promise<TokenChainResult> {
  if (!auth0Config.clientId) {
    throw new PkceLoginError(
      "configuration",
      "Auth0 clientId is not configured for the selected environment",
    );
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = nodeCrypto.randomBytes(16).toString("hex");

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

  // Bind, fail loudly on EADDRINUSE. The error listener is detached after a
  // successful bind so a late post-bind socket error doesn't try to reject an
  // already-resolved promise (silent no-op that would mask real failures).
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
        reject(err);
      }
    };
    server.on("error", onBindError);
    server.listen(OAUTH_CALLBACK_PORT, () => {
      server.off("error", onBindError);
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

  try {
    await bindResult;
  } catch (err) {
    if (timer) clearTimeout(timer);
    server.close();
    throw err;
  }

  try {
    await nodeOpen.open(
      buildAuthorizationUrl(auth0Config, codeChallenge, state),
    );
  } catch (err) {
    if (timer) clearTimeout(timer);
    server.close();
    throw new PkceLoginError(
      "configuration",
      `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let authCode: string;
  try {
    authCode = await Promise.race([codePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
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
