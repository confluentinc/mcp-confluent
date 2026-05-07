import type { Middleware } from "openapi-fetch";

/** Args of openapi-fetch's `onRequest` middleware hook. */
export type OnRequestArgs = Parameters<NonNullable<Middleware["onRequest"]>>[0];
/** Args of openapi-fetch's `onResponse` middleware hook. */
export type OnResponseArgs = Parameters<
  NonNullable<Middleware["onResponse"]>
>[0];

/**
 * Invokes a middleware's `onRequest` hook with stub fields openapi-fetch
 * always supplies. Returns whatever the hook returned (Request, Response,
 * or void).
 */
export async function callOnRequest(middleware: Middleware, request: Request) {
  if (!middleware.onRequest) {
    throw new Error("middleware.onRequest missing");
  }
  return middleware.onRequest({
    request,
    schemaPath: "",
    params: {} as OnRequestArgs["params"],
    options: {} as OnRequestArgs["options"],
    id: "test",
  });
}

/**
 * Invokes a middleware's `onResponse` hook with stub fields openapi-fetch
 * always supplies. Returns the substituted Response, if any.
 */
export async function callOnResponse(
  middleware: Middleware,
  request: Request,
  response: Response,
) {
  if (!middleware.onResponse) {
    throw new Error("middleware.onResponse missing");
  }
  return middleware.onResponse({
    request,
    response,
    schemaPath: "",
    params: {} as OnResponseArgs["params"],
    options: {} as OnResponseArgs["options"],
    id: "test",
  });
}
