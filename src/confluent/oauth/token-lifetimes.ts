/** 5 minutes in milliseconds — control plane token lifetime */
export const CONTROL_PLANE_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/** 10 minutes in milliseconds — data plane token lifetime */
export const DATA_PLANE_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/** 8 hours in milliseconds — refresh token absolute lifetime from original login */
export const REFRESH_TOKEN_ABSOLUTE_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** 4 hours in milliseconds — refresh token idle timeout, resets on each rotation */
export const REFRESH_TOKEN_IDLE_LIFETIME_MS = 4 * 60 * 60 * 1000;

/** 4 minutes in milliseconds — default auto-refresh interval (1 min before CP expiry) */
export const DEFAULT_REFRESH_INTERVAL_MS = 4 * 60 * 1000;
