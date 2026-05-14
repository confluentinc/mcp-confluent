## Relationships

Closes #419.

## Tool domain taxonomy

- Add a `ToolDomain` enum to [base-tools.ts](src/confluent/tools/base-tools.ts) — operator-facing classification of "what kind of tool is this?", orthogonal to the existing `ConnectionPredicate`-based "is this tool enabled?" question that lives next door. Predicates gate advertisement; domains classify intent for grouping in diagnostic surfaces and AI-client UX.
- `BaseToolHandler` gains `abstract readonly domain: ToolDomain`, mirroring the shape of `abstract readonly predicate`. The `ToolHandler` interface declares the property too so any future non-`BaseToolHandler` implementer must also supply one.
- The three existing domain base classes — `FlinkToolHandler`, `TableflowToolHandler`, `ConnectToolHandler` — declare `readonly domain = ToolDomain.X` once and pass it to their 28 subclasses by inheritance.
- The remaining 26 direct-`BaseToolHandler` subclasses each pick up one new line next to the existing `predicate` declaration.

The enum is deliberately coarser than the on-disk `handlers/<domain>/` tree: `ConfluentCloud` absorbs `clusters/`, `environments/`, and `organizations/` (one control plane in the operator's head); `Catalog` absorbs `search/` (topic search is a catalog read in practice). Coarser is the safer start — splitting later is additive (new enum value, pin-table rows flip, no caller breakage), while merging is disruptive.

## Surfaced via `tools/list`

Each tool's domain rides out as `_meta.domain` on its `tools/list` advertisement. Wired in [server.ts:49](src/mcp/server.ts#L49) — one extra field on the existing `registerTool` call — so a connected MCP client (Claude, an inspector, etc.) sees the taxonomy on day one without waiting on the diagnostic-tool followups. The SDK accepts `_meta` as `Record<string, unknown>` on `registerTool`'s config, and `ToolSchema._meta` carries it through unchanged on the wire.

## `--list-tools` CLI output groups by domain

`outputToolList` in [src/index.ts](src/index.ts) now buckets tools by `ToolDomain` and prints one bolded cyan section header per domain — operators running `--list-tools` get a "what's available in each functional area" view independent of registry-declaration order. Switching to `getToolHandler(toolName).getToolConfig()` at the call site orphaned `ToolHandlerRegistry.getToolConfig(toolName)` (the only caller), and the wrapper is deleted accordingly.

## `explain-disabled-tools` gains a `group_by` axis

[`ExplainDisabledToolsHandler`](src/confluent/tools/handlers/diagnostics/explain-disabled-tools-handler.ts) accepts an optional `group_by: "reason" | "domain"` argument, defaulting to `"reason"` (current behaviour). Flip to `"domain"` to regroup the same disabled-only data by `ToolDomain` — the question an operator asks when they think "what's offline in my Flink setup?" rather than "what config piece is missing?". Heading line and bucket headers both switch accordingly.

The bucket shape under the report's `disabledGroups` is now a discriminated union — `{ reason: ToolDisabledReason; tools }` under the default axis, `{ domain: ToolDomain; tools }` under the new one. Existing `_meta.disabledGroups[i].reason` consumers see no change unless they explicitly pass `group_by: "domain"`. The pre-existing `(connectionId, reason)` startup-log bucket type previously also named `DisabledToolGroup` is renamed to `StartupLogToolGroup` to clear the namespace collision — its only consumer is in [src/index.ts](src/index.ts), which reads the fields by name and is unaffected.

## Sample --list-tools output (now by domain):

```bash
$ node dist/index.js --list-tools
billing:
  list-billing-costs: Retrieve billing cost data for a Confluent Cloud organization within a specified date range with pagination support

catalog:
  add-tags-to-topic: Assign existing tags to Kafka topics in Confluent Cloud.
  create-topic-tags: Create new tag definitions in Confluent Cloud.
  delete-tag: Delete a tag definition from Confluent Cloud.
  list-tags: Retrieve all tags with definitions from Confluent Cloud Schema Registry.
  remove-tag-from-entity: Remove tag from an entity in Confluent Cloud.
  search-topics-by-name: List all topics in the Kafka cluster matching the specified name.
  search-topics-by-tag: List all topics in the Kafka cluster with the specified tag.

confluent-cloud:
  list-clusters: Get all clusters in the Confluent Cloud environment
  list-environments: Get all environments in Confluent Cloud with pagination support
  list-organizations: List Confluent Cloud organizations the current credentials can see. Paginated; if the response includes a nextPageTok...
  read-environment: Get details of a specific environment by ID
...
```
