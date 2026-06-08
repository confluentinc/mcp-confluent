# Rename `list-connections` to `list-configured-connections`

The discovery tool added in #560 sat one vowel away from our Confluent Cloud `connectors` product line, so an agent (or a human reading `tools/list`) could reasonably mistake "list connections" for "list connectors." Renaming it to `list-configured-connections` puts daylight between the MCP-server-introspection tool and the actual CCloud resource.

## Tool rename

The wire name exposed to clients changes from `list-connections` to `list-configured-connections`. The rename runs all the way through the internal symbols so no identifier outlives the name it described: the `ToolName.LIST_CONFIGURED_CONNECTIONS` enum member, the `ListConfiguredConnectionsHandler` class, the `list-configured-connections-handler.ts` file (and its colocated test), and the handler-local `listConfiguredConnectionsArguments` schema all move in lockstep.

The handler test now pins the literal wire string `"list-configured-connections"` rather than asserting `config.name` against the enum constant — the old assertion was tautological and would have happily passed whatever value the enum held, so it couldn't have caught a wrong rename.

## One source of truth for the `connectionId` description

The multi-connection `connectionId` parameter description is assembled in `base-tools.ts` from a fixed prefix plus a pointer sentence steering the agent at the discovery tool. That pointer string was duplicated as a literal in `base-tools.test.ts`, so the rename would have had two places to drift apart (per a #560 review comment).

Both pieces now live as exported constants on `base-tools.ts` — `CONNECTION_ID_DESCRIPTION_PREFIX` and `LIST_CONFIGURED_CONNECTIONS_POINTER` — and the test composes its expectation from them. The pointer constant holds the bare sentence with no leading space; the builder owns the joining space so the blocked-tool case (empty pointer) still leaves no dangling whitespace on the description.

The pointer interpolates the tool's wire name straight from `ToolName.LIST_CONFIGURED_CONNECTIONS` rather than re-typing the string, so a future rename can't leave the pointer prose pointing at a tool name that no longer exists. A test pins the pointer's full rendered sentence — the wire-name text was previously unpinned anywhere, which is how the duplicated literal slipped in; the test now flips red on any rename that changes the enum value, forcing a conscious update.

## Documentation

`CHANGELOG.md` (still under `## Unreleased` — the tool never shipped under the old name), `README.md`, `CONFIGURATION.md`, and both config examples now name `list-configured-connections`. Code comments in `index.ts`, `server-runtime.ts`, and `tool-metadata-handler.ts` that referenced the tool were updated alongside.

## Relationships

- Closes #562.
- Child of #532 (Epic: Multi-connection support).
- Follows #560, which introduced the tool under its original name.
