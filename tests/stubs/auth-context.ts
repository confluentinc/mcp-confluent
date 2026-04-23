import type { AuthContext } from "@src/confluent/oauth/auth-context.js";
import sinon from "sinon";

/**
 * An {@link AuthContext} whose predicate and mutation methods have been
 * replaced with {@link sinon.SinonStub sinon stubs}. Callers override the
 * stubs' return values per test to drive registry/tool behavior without
 * running the real token-chain fetches.
 */
export type StubbedAuthContext = {
  accessToken: string;
  hasValidControlPlaneToken: sinon.SinonStub;
  refreshTokenExpired: sinon.SinonStub;
  shouldAttemptRefresh: sinon.SinonStub;
  refresh: sinon.SinonStub;
  clear: sinon.SinonStub;
};

let nextStubId = 0;

/**
 * Creates an {@link AuthContext}-shaped stub. Defaults mirror a fresh,
 * healthy login: refresh token live, CP token valid but not due for refresh.
 * Pass `overrides` to adjust individual fields per test.
 */
export function createStubAuthContext(
  overrides: Partial<StubbedAuthContext> = {},
): AuthContext {
  const defaults: StubbedAuthContext = {
    accessToken: `stub-access-${nextStubId++}`,
    hasValidControlPlaneToken: sinon.stub().returns(true),
    refreshTokenExpired: sinon.stub().returns(false),
    shouldAttemptRefresh: sinon.stub().returns(false),
    refresh: sinon.stub().resolves(),
    clear: sinon.stub(),
  };
  return { ...defaults, ...overrides } as unknown as AuthContext;
}
