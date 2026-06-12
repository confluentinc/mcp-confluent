import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fs, path } from "@src/confluent/node-deps.js";
import { logger } from "@src/logger.js";

/**
 * `ui://` URI of the metrics-visualizer MCP App. Tools opt into the UI by
 * setting `ToolConfig.ui.resourceUri` to this value (see
 * {@link QueryMetricsHandler}); {@link createMcpServer} then advertises it as
 * `_meta.ui.resourceUri` on the tool registration.
 */
export const METRICS_VISUALIZER_URI = "ui://confluent/metrics-visualizer.html";

// Built by `npm run build:ui` into a single self-contained HTML file. Resolved
// relative to this compiled module (dist/mcp/app-resources.js → repo root).
const METRICS_VISUALIZER_HTML = path.resolve(
  import.meta.dirname,
  "../../ui/metrics-visualizer/dist/mcp-app.html",
);

/**
 * Register every MCP Apps UI resource on a freshly built server. Called once
 * per {@link McpServer} instance from {@link createMcpServer}, before tools are
 * registered. Resources are read lazily on each request so a rebuilt UI bundle
 * is picked up without restarting the server.
 */
export function registerAppResources(srv: McpServer): void {
  registerAppResource(
    srv,
    "Confluent Metrics Visualizer",
    METRICS_VISUALIZER_URI,
    { description: "Line-chart view of query-metrics time-series results." },
    async () => {
      const html = fs.readFileSync(METRICS_VISUALIZER_HTML, "utf-8");
      return {
        contents: [
          {
            uri: METRICS_VISUALIZER_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
          },
        ],
      };
    },
  );
  logger.debug(
    { uri: METRICS_VISUALIZER_URI },
    "Registered MCP Apps UI resource",
  );
}
