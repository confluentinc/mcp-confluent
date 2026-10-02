---
name: generate-clicktest-instructions
description:
  Generates manual, copy-paste clicktest instructions for a branch, PR, or feature in this
  project. Use when the user asks "how do I test this branch", "give me clicktest instructions",
  "manual testing steps for this PR", or similar. Drives every tool call through the real MCP
  Inspector or raw REST calls against live Confluent Cloud - never through a disposable script -
  and accounts for this project's two config paths (env-var vs YAML) and the current
  @modelcontextprotocol/inspector release's UI/CLI quirks.
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - WebFetch
  - WebSearch
---

# Generate Clicktest Instructions

Produces manual testing instructions for a change in this repo that a human can copy, paste, and
run against a real MCP server and real Confluent Cloud resources.
Automated `pnpm run test:unit` / `pnpm run test:integration` results are supporting evidence, not
a substitute - always mention them as already-done, never as the deliverable.

## Hard rule: never generate a one-off script

Do not write a disposable Node/TS file that imports `@modelcontextprotocol/sdk`'s `Client` /
`StdioClientTransport` (or any equivalent) to call tools programmatically as a workaround for
Inspector friction.
A script like that only this session will ever run - it doesn't teach the reviewer anything
about the project's real tooling, and it hides the exact UI quirk a future manual tester will
also hit.

Route every tool call through one of:

- the MCP Inspector (`pnpm run inspector`), web UI or `--cli` mode - see Step 3 for which to use
  and why
- raw `curl` against a Confluent Cloud REST API (Schema Registry, Kafka REST proxy, Cloud API)
  when the scenario needs to bypass the MCP server entirely - e.g. reproducing a schema or
  resource that was created by some _other_ client, not by this SDK
- a real MCP-capable client already documented for this project (e.g. `claude mcp add` per the
  README, `pnpm run start` / `pnpm run start:http` plus any client the user already has configured)

If Inspector's web UI genuinely cannot express a needed call (see the optional-object-field quirk
below), the fix is Inspector's own `--cli` mode or a documented client - not a bespoke script.

## Step 1: Triage the diff

```bash
git diff main...HEAD --stat
git diff main...HEAD
```

Identify:

- which `ToolName`(s) are affected, and which handler file(s) implement them
- which config surface is touched - `src/config/**` (YAML), `src/env-schema.ts` (legacy env),
  or a specific service integration (Kafka, Schema Registry, Flink, Tableflow, ...)
- whether the change is only reachable via a specific code path (e.g. "use latest schema" vs.
  "caller supplies an explicit schema") - the clicktest must exercise that exact path, not just
  the tool in general

Read the actual Zod input schema in every affected handler.
Never guess a tool's field names, types, or optionality from the PR description or from memory -
handlers under `src/confluent/tools/handlers/**` follow `.claude/rules/tool-handlers.md`, and the
schema is the only source of truth for what a client must send.
Cross-check with `pnpm run print:schema`, which prints every tool's schema as rendered to a real
client.

## Step 2: Confirm which config path governs the manual run, and get real var names

This project produces the same `MCPServerConfiguration` from two independent paths: the YAML path
(`-c <path>`, `loadConfigFromYaml`) and the legacy env-var path (`buildConfigFromEnvAndCli`).
`pnpm run inspector` and `pnpm run start` invoke the server with `--env-file .env`, so they go
through the **env-var path** by default - confirm this against the actual `package.json` script
and the user's setup rather than assuming, since a user's local `.env` can still point the server
at a YAML file via other means.

For the env-var path, read `src/env-schema.ts` for the authoritative variable names rather than
recalling them - they are grouped by service (`BOOTSTRAP_SERVERS` / `KAFKA_API_KEY` /
`KAFKA_API_SECRET` for Kafka, `SCHEMA_REGISTRY_ENDPOINT` / `SCHEMA_REGISTRY_API_KEY` /
`SCHEMA_REGISTRY_API_SECRET` for Schema Registry, `CONFLUENT_CLOUD_API_KEY` /
`CONFLUENT_CLOUD_API_SECRET` for the Cloud API, and similarly for Flink, Tableflow, and
Telemetry).
For an integration-style manual run instead, non-secret config lives in
`test-fixtures/yaml_configs/integration.yaml` and secrets in `.env.integration`
(`.env.integration.example` documents the variable names without values).

Never read or print a value that looks like a secret from `.env` or `.env.integration` - not even
"just to check" it.
Never load env vars by sourcing the file (`source .env` / `. .env`) either - that executes the
file's contents as shell code, which is an unnecessary code-execution footgun in a doc meant to be
copy-pasted.
Pull only the specific line(s) you need with `grep`, which never executes file contents:

```bash
schema_registry_endpoint=$(grep '^SCHEMA_REGISTRY_ENDPOINT=' .env | cut -d= -f2-)
echo "endpoint set: $([ -n "$schema_registry_endpoint" ] && echo yes || echo no)"
```

Confluent Cloud issues **three separate key pairs** that all look like `<KEY>:<SECRET>` in an
`.env` file but are not interchangeable: a Kafka cluster API key, a Schema Registry API key, and
a Cloud API key.
A `401` from Schema Registry, or a Kafka `broker transport failure`, encountered mid-clicktest is
very often the wrong key pair in the wrong variable, or a key that was since regenerated/revoked -
not a bug in the branch under test.
Isolate this with a cheap, side-effect-free probe before assuming the code is broken, again
pulling credentials with `grep` rather than sourcing the file:

```bash
schema_registry_endpoint=$(grep '^SCHEMA_REGISTRY_ENDPOINT=' .env | cut -d= -f2-)
schema_registry_api_key=$(grep '^SCHEMA_REGISTRY_API_KEY=' .env | cut -d= -f2-)
schema_registry_api_secret=$(grep '^SCHEMA_REGISTRY_API_SECRET=' .env | cut -d= -f2-)

curl -s -o /dev/null -w "%{http_code}\n" "$schema_registry_endpoint/subjects" \
  -u "$schema_registry_api_key:$schema_registry_api_secret"
```

A non-`200` here means fix the credentials (regenerate the key in the Confluent Cloud console for
the _correct_ resource - Kafka cluster vs. Schema Registry vs. Cloud API) before continuing the
clicktest.

## Step 3: Re-check the Inspector's current behavior - do not rely on memory

`@modelcontextprotocol/inspector` is under active development (a v2 line under active development
on `v2/main`, released to `main`/npm `latest`); its CLI flags and web-form behavior can differ
from what an earlier session observed.
Before writing instructions that name specific flags or describe specific UI behavior:

1. Check the version actually in play: `grep -n "inspector" package.json` (this project's
   `inspector` script npx-invokes it unpinned), and if it's not pinned, find the resolved version
   either by running `npx @modelcontextprotocol/inspector --help` or by reading
   `~/.npm/_npx/*/node_modules/@modelcontextprotocol/inspector/package.json` under the npx cache.
2. WebFetch or WebSearch the `modelcontextprotocol/inspector` repo's current README (and its
   `clients/cli` / `clients/web` READMEs) for that version rather than hard-coding flags from a
   prior conversation.

The following are quirks observed on Inspector v2 (`mcp-inspector` binary dispatching to `--web`
(default) / `--cli` / `--tui`) - reverify against whatever version Step 3.1 finds before repeating
them verbatim, since they may have been fixed or changed:

- Mode flags (`--web`, `--cli`, `--tui`) must appear before app options; everything after is
  forwarded unchanged to the target server command.
- The web UI renders **one form field per top-level tool-input parameter**. For a parameter typed
  as an array of objects (e.g. `topics: {topic, numPartitions}[]` on `create-topics`), that field
  expects only the array's own JSON value. Pasting the whole wrapper object
  (`{"topics": [...]}`) into the `topics` field double-wraps it and fails with something like
  `expected array, received object`.
- For a parameter typed as an **optional nested object with required sub-fields** (e.g. the `key`
  parameter on `produce-message`, a `.optional()` Zod object whose inner `message` field is
  required), clearing that field's textarea in the web UI does not omit the parameter - it can
  still submit `{}`, which then fails downstream on the required sub-field (`key.message`).
  This is a web-UI limitation, not a defect in the server or in the branch under test.
  Work around it with `--cli` mode, which lets the caller supply exact JSON-RPC arguments and
  genuinely omit a field, rather than by writing a script (see the hard rule above).

## Step 4: Write the instructions

Shape the output as literal, copy-paste-ready commands (per the user's standing preference for
manual clicktest instructions), scoped to what Steps 1-3 actually found:

1. Build: `pnpm run build`.
2. Start: `pnpm run inspector` (or `pnpm run start` / `pnpm run start:http` for a non-Inspector
   manual run), stating which config path it uses per Step 2.
3. Any out-of-band setup needed to land the server in the exact state the fix targets - e.g., a
   Schema Registry REST `curl` call to register a schema in a shape this SDK's own client would
   never produce, when the bug is specifically about reading state created by another client.
   Use real, inlined, non-secret values (topic/subject names, schema text) and reference secret
   env vars by name only, read from the user's existing `.env` / `.env.integration` via `grep`
   (never by sourcing the file - see Step 2).
4. The exact tool call(s) to make - tool name, and the literal JSON for each field - calling out
   any Step 3 UI quirk that applies to this specific tool's schema (e.g. "leave `key` blank; if
   the web UI still sends `{}`, switch to `--cli` mode for this call").
   State the expected result to check for, not just "run it".
5. A regression check when the fix touches one of several code paths - the pre-existing path(s)
   must keep working, not just the new one.
6. Cleanup: delete any topics/subjects/environments created for the test.

## Step 5: Reprint the full instructions on every round-trip

Manual clicktesting is a back-and-forth: the user runs a command, hits a credential problem, a
schema mismatch, or an Inspector UI quirk, and reports the result.
When that happens, never reply with just the isolated fix in place of the fix in context - repost
the complete, updated sequence of remaining steps with the fix folded in, so the user always has
one current, copy-paste-ready block rather than having to reconstruct the current state of the
test from fragments scattered across several turns.

This applies on every turn of the exchange, not only once at the end of troubleshooting: after
the user reports an error, after they report a fix (like rotating a credential), and after each
successful step that leads into another.
A reply that says only "now run X" without reprinting the steps around it is not sufficient - if
step 3 changed, reprint steps 3 through the end, in full, every time.

## Anti-patterns to refuse

- A disposable script that calls tools directly to route around Inspector friction - use `--cli`
  mode or a documented client instead.
- Env var names or handler field names recalled from a previous PR or conversation instead of
  re-read from `src/env-schema.ts` / the handler's Zod schema for _this_ branch.
- Printing secret values from `.env` / `.env.integration`, even for troubleshooting.
- Hard-coding Inspector flag syntax or UI behavior without checking the currently-installed/
  documented version first.
- Answering a mid-troubleshooting message with only the isolated fix instead of the full,
  updated instructions - see Step 5.

## Tips

- If the change touches `src/confluent/tools/handlers/**`, check the handler's `predicate` (see
  `.claude/rules/tool-handlers.md`) to know which service blocks (`kafka`, `schema_registry`,
  `flink`, ...) must be present in the manual-test `.env`/YAML for the tool to be enabled at all.
- `pnpm run print:schema` is the fastest way to see exactly what a real client will render for a
  tool's input schema, without reading the Zod source by hand.
- When a `401`/auth failure surfaces mid-clicktest, resolve it as a credentials problem (Step 2)
  before concluding the branch under test is broken.
