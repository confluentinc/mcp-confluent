/** A single auth-lifecycle error with transience flag. */
export interface AuthError {
  message: string;
  /**
   * True if expected to resolve on retry. False means the scheduler stops
   * retrying until the context is cleared or re-authenticated.
   */
  isTransient: boolean;
}

/**
 * Record of auth-lifecycle errors — one optional entry per phase.
 * `signIn` is intentionally omitted: sign-in failures throw from
 * {@link AuthContext.newFromInitialLogin} before any context exists, so they
 * have no instance on which to be stored.
 */
export interface AuthErrors {
  /** Populated when a token refresh attempt fails. */
  tokenRefresh?: AuthError;
  /**
   * Populated when an active token health check fails. Not set today;
   * reserved for a follow-up that adds a `/api/check_jwt` probe.
   */
  authStatusCheck?: AuthError;
}

/** True if any recorded error is flagged non-transient. */
export function hasNonTransientError(errors: AuthErrors): boolean {
  return (
    errors.tokenRefresh?.isTransient === false ||
    errors.authStatusCheck?.isTransient === false
  );
}
