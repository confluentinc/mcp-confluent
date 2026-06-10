#!/usr/bin/env node

import {
  CLIOptions,
  DisplayedCommandLineUsageError,
  getFilteredToolNames,
  getPackageVersion,
  loadDotEnvFile,
  parseCliArgs,
} from "@src/cli.js";
import {
  buildConfigFromEnvAndCli,
  loadConfigFromYaml,
  MCPServerConfiguration,
} from "@src/config/index.js";
import { buildConfigTelemetry } from "@src/confluent/config-telemetry.js";
import { buildConfig, fs, path } from "@src/confluent/node-deps.js";
import { TelemetryEvent, TelemetryService } from "@src/confluent/telemetry.js";
import { ToolCategory, ToolHandler } from "@src/confluent/tools/base-tools.js";
import { groupDisabledToolsByReason } from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";
import { logger, setLogLevel } from "@src/logger.js";
import { CreateMcpServerOptions } from "@src/mcp/server.js";
import { generateApiKey, TransportManager } from "@src/mcp/transports/index.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * Resolve the operator's tool allow/block-list into the set `ServerRuntime`
 * gates on. When neither list is configured, this is the curated
 * {@link DEFAULT_ENABLED_TOOLS} set rather than the full catalog — the
 * defaulting lives in `getFilteredToolNames`, so this resolver and the
 * `--list-tools` output stay in lockstep. Always returns a concrete set;
 * `ServerRuntime.isToolAllowed` still tolerates `undefined` for callers (tests)
 * that construct a runtime without an allow-list.
 */
export function resolveAllowedToolNames(
  allowTools: string[],
  blockTools: string[],
): ReadonlySet<ToolName> {
  return new Set(getFilteredToolNames(allowTools, blockTools));
}

/**
 * Determine the subset of ToolHandlers to register: those left enabled by the
 * runtime's operator allow/block-list (`runtime.isToolAllowed`) whose predicate
 * is also satisfied (typically by at least one configured connection).
 **/
export function getToolHandlersToRegister(
  runtime: ServerRuntime,
): Map<ToolName, ToolHandler> {
  const toolHandlersToRegister = new Map<ToolName, ToolHandler>();
  const knownIds = new Set(Object.keys(runtime.config.connections));

  // Pass 1: drop tools excluded by the allow/block list (logged per-tool —
  // the reason is config-driven, not predicate-driven, so it doesn't fold
  // into the grouped warning emitted later). The filter lives on the runtime
  // so registration and the list-configured-connections tool read one source of truth.
  const candidates: Array<readonly [ToolName, ToolHandler]> = [];
  const excludedByList: ToolName[] = [];
  for (const toolName of Object.values(ToolName)) {
    if (!runtime.isToolAllowed(toolName)) {
      excludedByList.push(toolName);
      logger.debug(`Tool ${toolName} disabled due to allow/block list rules`);
      continue;
    }
    candidates.push([toolName, ToolHandlerRegistry.getToolHandler(toolName)]);
  }
  // One summary line instead of one warning per excluded tool — with the
  // default tool set most of the catalog is off, and per-tool warnings would
  // bury the startup log. The per-tool detail stays at debug above.
  if (excludedByList.length > 0) {
    logger.info(
      `${excludedByList.length} tool(s) are off due to allow/block-list rules. ` +
        "Enable specific tools with --allow-tools, or call the explain-disabled-tools tool to see them.",
    );
  }

  // Pass 2: register tools that are enabled on at least one connection.
  for (const [toolName, handler] of candidates) {
    const enabledIds = handler.enabledConnectionIds(runtime);
    const unknownIds = enabledIds.filter((id) => !knownIds.has(id));
    if (unknownIds.length > 0) {
      throw new Error(
        `Tool ${toolName}: enabledConnectionIds() returned unknown connection ID(s): ${unknownIds.join(", ")}`,
      );
    }
    if (enabledIds.length > 0) {
      toolHandlersToRegister.set(toolName, handler);
      logger.info(`Tool ${toolName} enabled`);
    }
  }

  // Pass 3: emit one grouped warning per (connectionId, reason) for tools
  // that are fully disabled — readers see the missing config piece and the
  // list of all tools blocked by it in a single line, rather than one
  // line per tool.
  for (const group of groupDisabledToolsByReason(candidates, runtime)) {
    logger.warn(
      `Tools disabled on connection '${group.connectionId}' — ${group.reason}: ${group.toolNames.join(", ")}`,
    );
  }

  // Raise an error if no tools are enabled, as the server would be non-functional without any tools.
  if (toolHandlersToRegister.size === 0) {
    throw new Error(
      "No tools enabled. Please check your configuration and environment variables.",
    );
  }

  return toolHandlersToRegister;
}

/**
 * Resolve the Segment write key handed to `TelemetryService.initialize`.
 *
 * Precedence: an explicit YAML `server.analytics.write_key` wins; otherwise
 * fall back to `buildConfig.TELEMETRY_WRITE_KEY` (the value `npm pack` injects
 * at release time). On unpacked / dev builds the build-time value is empty,
 * so an absent YAML field produces an empty-string fallback that
 * `TelemetryService` treats as "no key supplied" — analytics stays off.
 *
 * Extracted from `main()` so the precedence is unit-testable without booting
 * the full server.
 */
export function resolveTelemetryWriteKey(
  mcpConfig: MCPServerConfiguration,
): string | undefined {
  return (
    mcpConfig.server.analytics?.write_key ?? buildConfig.TELEMETRY_WRITE_KEY
  );
}

export function outputApiKey(): void {
  const apiKey = generateApiKey();
  console.log("\nGenerated MCP API Key:");
  console.log("=".repeat(64));
  console.log(apiKey);
  console.log("=".repeat(64));
  console.log("\nAdd this to your .env file:");
  console.log(`MCP_API_KEY=${apiKey}\n`);
}

/**
 * Bootstrap a starter `config.yaml` in the current working directory by
 * copying one of the bundled example templates, then ensure the new file
 * is listed in `<cwd>/.gitignore` so credentials filled in later don't
 * slip into git.
 *
 * Resolved relative to `import.meta.url` (the compiled `dist/index.js`)
 * so this keeps working when invoked via `npx`, where `process.cwd()`
 * is the user's project but the example file lives next to the install.
 *
 * Refuses to overwrite an existing destination so an accidental rerun
 * cannot wipe credentials the user already filled in. The write uses
 * `wx` (exclusive create) so the existence check and the create happen
 * as a single syscall — there is no TOCTOU window where another process
 * could create the file between a precheck and the write.
 *
 * @param oauth When true, copy `config.oauth.example.yaml` (the minimal
 *   OAuth template); when false, copy `config.example.yaml` (the
 *   fully-annotated direct/api-key template). The CLI flag in the EEXIST
 *   error message is selected to match.
 */
export function outputInitConfig(oauth: boolean = false): void {
  const sourceFileName = oauth
    ? "config.oauth.example.yaml"
    : "config.example.yaml";
  const flagName = oauth ? "init-oauth-config" : "init-config";
  const sourceUrl = new URL(`../${sourceFileName}`, import.meta.url);
  const destPath = path.resolve("config.yaml");

  const contents = fs.readFileSync(sourceUrl, "utf-8");
  try {
    fs.writeFileSync(destPath, contents, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `config.yaml already exists at ${destPath}. ` +
          `Remove or rename it before running --${flagName}.`,
      );
    }
    throw err;
  }

  const gitignoreNote = ensureGitignoreEntry(destPath);

  console.log(`wrote ./config.yaml (${gitignoreNote})`);
  // OAuth has no credentials to edit; the bundled template is already
  // runnable as-is. The api-key template, by contrast, ships placeholder
  // values the user must fill in before the server can connect.
  console.log(
    oauth
      ? `Next: run with --config ./config.yaml`
      : `Next: edit credentials in config.yaml and run with --config ./config.yaml`,
  );
}

/**
 * Ensure the basename of `filePath` is listed in `<dirname(filePath)>/.gitignore`.
 * Creates the gitignore if missing; appends idempotently if present (matching
 * trimmed lines verbatim — `*.yaml` globs or `/config.yaml` anchors are not
 * recognized, so a user who already wrote either form will see a duplicate
 * `config.yaml` entry, which is harmless).
 *
 * @returns A short note describing what happened, suitable for the success message.
 */
function ensureGitignoreEntry(filePath: string): string {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  const gitignorePath = path.join(dir, ".gitignore");

  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, `${fileName}\n`);
    return "added to .gitignore";
  }

  const existing = fs.readFileSync(gitignorePath, "utf-8");
  const alreadyListed = existing
    .split("\n")
    .some((line) => line.trim() === fileName);
  if (alreadyListed) {
    return ".gitignore already excludes it";
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(gitignorePath, `${prefix}${fileName}\n`);
  return "added to .gitignore";
}

export function outputToolList(filteredToolNames: ToolName[]): void {
  const MAX_DESC_LENGTH = 120;

  // Bucket by ToolCategory. Today's callers pass `filteredToolNames` in
  // registry-declaration order, which already roughly groups same-category
  // tools, but we re-bucket explicitly here so the rendered layout doesn't
  // depend on that incidental ordering.
  const byCategory = new Map<
    ToolCategory,
    Array<{ name: ToolName; desc: string }>
  >();
  // --list-tools runs before any config is loaded, so there is no real runtime.
  // A zero-connection runtime makes getRegisteredToolConfig() return each tool's
  // authored config verbatim (no connectionId augmentation), which is exactly
  // the connection-independent catalog view this listing wants.
  const runtime = new ServerRuntime(
    new MCPServerConfiguration({ connections: {} }),
    {},
  );
  for (const toolName of filteredToolNames) {
    const handler = ToolHandlerRegistry.getToolHandler(toolName);
    const config = handler.getRegisteredToolConfig(runtime);
    let desc = config.description.replaceAll(/\s+/g, " ").trim();
    if (desc.length > MAX_DESC_LENGTH) {
      desc = desc.slice(0, MAX_DESC_LENGTH - 3) + "...";
    }
    let bucket = byCategory.get(handler.category);
    bucket ??= [];
    byCategory.set(handler.category, bucket);
    bucket.push({ name: toolName, desc });
  }

  // Categories rendered lex-sorted (kebab-case enum values sort cleanly);
  // within each category, tools preserve the order they appeared in
  // `filteredToolNames` (today: registry-declaration order, as supplied
  // by the caller).
  const sortedCategories = Array.from(byCategory.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  sortedCategories.forEach((category, idx) => {
    console.log(`\x1b[1;36m${category}:\x1b[0m`);
    for (const { name, desc } of byCategory.get(category)!) {
      console.log(`  \x1b[32m${name}\x1b[0m: ${desc}`);
    }
    // Blank line between sections, but not after the last category.
    if (idx < sortedCategories.length - 1) console.log("");
  });
}

/**
 * Result of {@link handleEarlyExits}. Returning a value instead of calling
 * `process.exit` directly keeps the function pure enough that tests can
 * assert dispatch behavior by inspecting the result + per-output spies,
 * without having to stub `process.exit`.
 */
export type EarlyExitResult =
  | { handled: false }
  | { handled: true; exitCode: 0 }
  | { handled: true; exitCode: 1; stderr: string };

/**
 * Dispatch the CLI's mutually-exclusive early-exit modes — generate-key,
 * init-config, init-oauth-config, and list-tools — before the server
 * bootstrap begins. Returns `{ handled: false }` when none apply, in
 * which case the caller continues with normal startup.
 *
 * On init-config failure, the friendly error message is returned in
 * `stderr` rather than written here, so the caller controls writing to
 * stderr and exiting.
 */
export function handleEarlyExits(cliOptions: CLIOptions): EarlyExitResult {
  if (cliOptions.generateKey) {
    outputApiKey();
    return { handled: true, exitCode: 0 };
  }
  if (cliOptions.initConfig) {
    return runOutputInitConfig(false);
  }
  if (cliOptions.initOauthConfig) {
    return runOutputInitConfig(true);
  }
  if (cliOptions.listTools) {
    outputToolList(
      getFilteredToolNames(
        cliOptions.allowTools ?? [],
        cliOptions.blockTools ?? [],
      ),
    );
    return { handled: true, exitCode: 0 };
  }
  return { handled: false };
}

function runOutputInitConfig(oauth: boolean): EarlyExitResult {
  try {
    outputInitConfig(oauth);
    return { handled: true, exitCode: 0 };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const flag = oauth ? "--init-oauth-config" : "--init-config";
    return { handled: true, exitCode: 1, stderr: `${flag} failed: ${msg}` };
  }
}

async function main() {
  try {
    // Parse command line arguments.(NO LONGER LOADS ENV VARS FROM -e file!)
    const cliOptions = parseCliArgs(process.argv);

    const earlyExit = handleEarlyExits(cliOptions);
    if (earlyExit.handled) {
      if (earlyExit.exitCode === 1) {
        console.error(earlyExit.stderr);
      }
      process.exit(earlyExit.exitCode);
    }

    const allowedToolNames = resolveAllowedToolNames(
      cliOptions.allowTools ?? [],
      cliOptions.blockTools ?? [],
    );

    if (cliOptions.envFile) {
      loadDotEnvFile(cliOptions.envFile);
    }

    // Convert our known env vars into a typed Environment obj.
    const env = initEnv();

    let mcpConfig: MCPServerConfiguration;
    // Load and validate configuration — from YAML file if --config provided, else from env vars + CLI overrides.
    if (cliOptions.config) {
      mcpConfig = loadConfigFromYaml(cliOptions.config, process.env);
    } else {
      mcpConfig = buildConfigFromEnvAndCli(env, {
        disableAuth: cliOptions.disableAuth,
        allowedHosts: cliOptions.allowedHosts,
        kafkaConfig: cliOptions.kafkaConfig,
        oauth: cliOptions.oauth,
        ccloudEnv: cliOptions.ccloudEnv,
      });
    }

    setLogLevel(mcpConfig.server.log_level);

    // Transport selection: YAML config is authoritative when --config is used;
    // CLI flag (or its default) is used on the env-var path.
    const transports = cliOptions.config
      ? mcpConfig.server.transports
      : cliOptions.transports;

    // DO_NOT_TRACK is a cross-tool user preference (consoledonottrack.com);
    // the env var acts as a floor so it is honored even when --config is used.
    TelemetryService.initialize({
      doNotTrack: mcpConfig.server.do_not_track || env.DO_NOT_TRACK,
      writeKey: resolveTelemetryWriteKey(mcpConfig),
    });
    const telemetry = TelemetryService.getInstance();

    logger.info(
      `${mcpConfig.getConnectionNames().length} connections loaded successfully`,
    );

    const runtime = ServerRuntime.fromConfig(mcpConfig, allowedToolNames);

    const serverVersion = getPackageVersion();

    telemetry.setCommonProperties({ serverVersion });

    const toolHandlers = getToolHandlersToRegister(runtime);

    logger.info(
      { enabledTools: [...toolHandlers.keys()] },
      `${toolHandlers.size} tool(s) enabled`,
    );

    // Warn if auth is disabled
    if (mcpConfig.server.auth.disabled) {
      logger.warn(
        "Authentication is DISABLED for HTTP/SSE transports. " +
          "This should only be used in development environments.",
      );
    }

    const transportManager = new TransportManager({
      disableAuth: mcpConfig.server.auth.disabled,
      allowedHosts: mcpConfig.server.auth.allowed_hosts,
      apiKey: mcpConfig.server.auth.api_key,
    });

    const serverOptions: CreateMcpServerOptions = {
      serverVersion,
      toolHandlers,
      runtime,
      track: (props) =>
        telemetry.track(TelemetryEvent.TOOL_CALL, {
          ...props,
        }),
    };

    // Start all transports with a single call
    logger.info(`Starting transports: ${transports.join(", ")}`);
    await transportManager.start({
      serverOptions,
      types: transports,
      http: {
        port: mcpConfig.server.http.port,
        host: mcpConfig.server.http.host,
        mcpEndpointPath: mcpConfig.server.http.mcp_endpoint,
        sseEndpointPath: mcpConfig.server.http.sse_endpoint,
        sseMessageEndpointPath: mcpConfig.server.http.sse_message_endpoint,
      },
    });

    // Boot-time invariants (config source, active transports, connection
    // types) ride this one-shot event rather than every TOOL_CALL — they
    // don't change after startup, so duplicating them per tool call buys
    // nothing. Warehouse queries join SERVER_START to TOOL_CALL on
    // `serverSessionId` (a common property) when slicing is needed.
    telemetry.track(TelemetryEvent.SERVER_START, {
      ...buildConfigTelemetry(cliOptions, mcpConfig, transports),
    });

    // Set up cleanup handlers
    const performCleanup = async () => {
      logger.info("Shutting down...");
      await telemetry.shutdown();
      await transportManager.stop();
      // shutdown() is race-safe with an in-flight bootstrap.
      runtime.oauthHolder?.shutdown();
      await runtime.clientManager.disconnect();
      process.exit(0);
    };

    process.on("SIGINT", performCleanup);
    process.on("SIGTERM", performCleanup);
    process.on("SIGQUIT", performCleanup);
    process.on("SIGUSR2", performCleanup);
  } catch (error) {
    if (error instanceof DisplayedCommandLineUsageError) {
      process.exit(0);
    }
    logger.error({ err: error }, "Error starting server");
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  await main();
}
