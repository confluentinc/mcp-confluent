import {
  BaseToolHandler,
  ToolHandler,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";

/**
 * Base class for tools that introspect the server's own tool catalog —
 * `list-configured-connections`, `explain-disabled-tools`, and (incoming) the
 * `describe-connection` tool of #550.
 *
 * The catalog is reached through `registryAccessor`, a thunk, rather than a
 * direct `ToolHandlerRegistry` import. `ToolHandlerRegistry` constructs these
 * handlers eagerly in its static field initializer, so a handler that imported
 * the registry back would close an ESM cycle: on any load order that reaches
 * the handler module first (a colocated unit test, say), the registry's `new
 * SubclassHandler()` runs while the subclass binding is still in its temporal
 * dead zone — a `ReferenceError`. The accessor keeps the import arrow pointing
 * one way (registry → handler) and, crucially, stays un-invoked until request
 * time: calling it during construction would re-enter `allHandlers()` while the
 * registry's `handlers` map is still `undefined`. Subclasses read the catalog
 * via {@link getToolNamesAndHandlers}.
 */
export abstract class ToolMetadataHandler extends BaseToolHandler {
  private readonly registryAccessor: () => Iterable<
    readonly [ToolName, ToolHandler]
  >;

  constructor(
    registryAccessor: () => Iterable<readonly [ToolName, ToolHandler]>,
  ) {
    super();
    this.registryAccessor = registryAccessor;
  }

  /**
   * The tool catalog as a fresh array, materialized at request time. Always
   * call this from `handle()`, never the accessor at construction time — see
   * the class docstring for why the deferral is load-bearing.
   */
  protected getToolNamesAndHandlers(): ReadonlyArray<
    readonly [ToolName, ToolHandler]
  > {
    return [...this.registryAccessor()];
  }
}
