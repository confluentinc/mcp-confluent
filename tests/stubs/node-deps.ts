import * as nodeDeps from "@src/confluent/node-deps.js";
import type {
  Server as HttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { type MockInstance, vi } from "vitest";

/**
 * Spies installed on every fs wrapper method in {@linkcode nodeDeps.fs}.
 * Auto-restored between tests by the `restoreMocks: true` setting in
 * `vitest.config.ts`.
 *
 * Read methods (`existsSync`, `readFileSync`) call through to the real fs
 * by default; tests should override with `.mockReturnValue(...)`. Write
 * methods (`writeFileSync`, `mkdirSync`) are no-op-by-default to prevent
 * an unmocked call from accidentally mutating the real filesystem.
 */
export type MockedFsWrappers = {
  existsSync: MockInstance<typeof nodeDeps.fs.existsSync>;
  readFileSync: MockInstance<typeof nodeDeps.fs.readFileSync>;
  writeFileSync: MockInstance<typeof nodeDeps.fs.writeFileSync>;
  mkdirSync: MockInstance<typeof nodeDeps.fs.mkdirSync>;
};

/**
 * Installs {@linkcode vi.spyOn} on each fs wrapper method.
 *
 * Read spies (`existsSync`, `readFileSync`) call through by default; real
 * `existsSync` on a non-existent path returns `false` and real `readFileSync`
 * throws ENOENT, both of which surface a missed mock loudly. Write spies
 * (`writeFileSync`, `mkdirSync`) are no-op-by-default so an unmocked call
 * doesn't accidentally mutate the real filesystem.
 *
 * @example
 * ```ts
 * const fsMocks = createFsWrappers();
 * fsMocks.existsSync.mockReturnValue(true);
 * fsMocks.readFileSync.mockReturnValue("file contents");
 * ```
 */
export function createFsWrappers(): MockedFsWrappers {
  return {
    existsSync: vi.spyOn(nodeDeps.fs, "existsSync"),
    readFileSync: vi.spyOn(nodeDeps.fs, "readFileSync"),
    writeFileSync: vi
      .spyOn(nodeDeps.fs, "writeFileSync")
      .mockImplementation(() => undefined),
    mkdirSync: vi
      .spyOn(nodeDeps.fs, "mkdirSync")
      .mockImplementation(
        () => undefined as ReturnType<typeof nodeDeps.fs.mkdirSync>,
      ),
  };
}

/**
 * Spy on the env-proxy getter ({@linkcode nodeDeps.config.env}) and return
 * the supplied partial as the full env object. Lets tests express only the
 * env vars they actually care about without listing every other field.
 *
 * @example
 * ```ts
 * mockEnv({ DO_NOT_TRACK: true });
 * ```
 */
export function mockEnv(overrides: Partial<typeof nodeDeps.config.env>): void {
  vi.spyOn(nodeDeps.config, "env", "get").mockReturnValue(
    overrides as unknown as typeof nodeDeps.config.env,
  );
}

/**
 * Spy returned by {@linkcode mockFetch}. Auto-restored between tests by the
 * `restoreMocks: true` setting in `vitest.config.ts`.
 */
export type MockedFetch = MockInstance<typeof nodeDeps.nodeFetch.fetch>;

/**
 * Install a {@linkcode vi.spyOn} on {@linkcode nodeDeps.nodeFetch.fetch} that
 * throws "Unexpected fetch" by default. Tests must opt-in to each expected
 * request via `.mockResolvedValueOnce(...)` (preferred for chains) or
 * `.mockResolvedValue(...)` (steady-state) so that missed mocks fail loudly
 * instead of hitting the real network.
 *
 * @example
 * ```ts
 * const fetchSpy = mockFetch();
 * fetchSpy.mockResolvedValueOnce(new Response('{"ok":true}'));
 * ```
 */
export function mockFetch(): MockedFetch {
  return vi.spyOn(nodeDeps.nodeFetch, "fetch").mockImplementation(async () => {
    throw new Error(
      "mockFetch(): unstubbed fetch call. " +
        "Add .mockResolvedValueOnce(response) per expected request, " +
        "or .mockResolvedValue(response) for a steady-state default.",
    );
  });
}

/**
 * Spy returned by {@linkcode mockDotenv}.
 */
export type MockedDotenv = MockInstance<typeof nodeDeps.dotenvLib.config>;

/**
 * Install a {@linkcode vi.spyOn} on {@linkcode nodeDeps.dotenvLib.config}
 * that throws "Unexpected dotenv.config" by default. Calling the real
 * `dotenv.config` mutates `process.env` (a shared singleton) using the
 * developer's cwd-local `.env` file, which can leak non-deterministic state
 * into other tests; this helper makes any unmocked invocation fail loudly.
 *
 * @example
 * ```ts
 * const dotenvSpy = mockDotenv();
 * dotenvSpy.mockReturnValue({ parsed: { FOO: "bar" } });
 * ```
 */
export function mockDotenv(): MockedDotenv {
  return vi.spyOn(nodeDeps.dotenvLib, "config").mockImplementation(() => {
    throw new Error(
      "mockDotenv(): unstubbed dotenv.config() call. " +
        "Add .mockReturnValue({ parsed: { ... } }) for a successful load, " +
        "or .mockReturnValue({ error: new Error(...) }) for a failure.",
    );
  });
}

/** Spy returned by {@linkcode mockOpen}. */
export type MockedOpen = MockInstance<typeof nodeDeps.nodeOpen.open>;

/**
 * Install a {@linkcode vi.spyOn} on {@linkcode nodeDeps.nodeOpen.open} that
 * resolves to a no-op by default. Callers may override per-test with
 * `.mockResolvedValue(...)` or assert calls with `.toHaveBeenCalledWith(...)`.
 */
export function mockOpen(): MockedOpen {
  return vi
    .spyOn(nodeDeps.nodeOpen, "open")
    .mockResolvedValue(
      undefined as unknown as Awaited<
        ReturnType<typeof nodeDeps.nodeOpen.open>
      >,
    );
}

/**
 * Test handle returned by {@linkcode mockHttpServer}. Tests drive the fake
 * server by:
 *  - awaiting `listening` (resolves once production code calls `.listen`)
 *  - calling `fireRequest(url)` to deliver a synthetic request to the registered listener
 *  - asserting `closed` after the production code finishes
 */
export type MockedHttpServer = {
  spy: MockInstance<typeof nodeDeps.nodeHttp.createServer>;
  listening: Promise<number>;
  fireRequest: (url: string) => Promise<{ statusCode: number; body: string }>;
  setListenError: (err: NodeJS.ErrnoException) => void;
  closed: () => boolean;
};

/**
 * Install a fake HTTP server. Returns a handle the test uses to inject a
 * fake redirect request and observe lifecycle.
 */
export function mockHttpServer(): MockedHttpServer {
  let requestHandler:
    | ((req: IncomingMessage, res: ServerResponse) => void)
    | null = null;
  let listenResolve: ((port: number) => void) | null = null;
  let listenError: NodeJS.ErrnoException | null = null;
  const errorListeners: Array<(err: Error) => void> = [];
  const closeListeners: Array<() => void> = [];
  let isClosed = false;
  const listening = new Promise<number>((resolve) => {
    listenResolve = resolve;
  });

  const fakeServer: Partial<HttpServer> = {
    listen(port?: unknown, hostnameOrCb?: unknown, cb?: unknown) {
      // Support both listen(port, cb) and listen(port, hostname, cb) overloads.
      const resolvedCb = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
      if (listenError) {
        queueMicrotask(() =>
          errorListeners.forEach((fn) => fn(listenError as Error)),
        );
      } else {
        const numericPort = typeof port === "number" ? port : 0;
        listenResolve?.(numericPort);
        if (typeof resolvedCb === "function") (resolvedCb as () => void)();
      }
      return fakeServer as HttpServer;
    },
    close(cb?: unknown) {
      isClosed = true;
      closeListeners.forEach((fn) => fn());
      if (typeof cb === "function") (cb as (err?: Error) => void)();
      return fakeServer as HttpServer;
    },
    on(event: unknown, listener: unknown) {
      if (event === "error")
        errorListeners.push(listener as (err: Error) => void);
      if (event === "close") closeListeners.push(listener as () => void);
      return fakeServer as HttpServer;
    },
  };

  const spy = vi
    .spyOn(nodeDeps.nodeHttp, "createServer")
    .mockImplementation((handler: unknown) => {
      requestHandler = handler as typeof requestHandler;
      return fakeServer as HttpServer;
    });

  const fireRequest = async (
    url: string,
  ): Promise<{ statusCode: number; body: string }> => {
    if (!requestHandler) {
      throw new Error("mockHttpServer.fireRequest called before createServer");
    }
    let statusCode = 200;
    let body = "";
    const fakeReq = { url, method: "GET" } as unknown as IncomingMessage;
    const fakeRes = {
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (text?: string) => {
        if (typeof text === "string") body = text;
      },
      setHeader: () => undefined,
    } as unknown as ServerResponse;
    requestHandler(fakeReq, fakeRes);
    return { statusCode, body };
  };

  return {
    spy,
    listening,
    fireRequest,
    setListenError: (err) => {
      listenError = err;
    },
    closed: () => isClosed,
  };
}
