# Configuring Windsurf

Add the MCP server to your Windsurf configuration at `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "confluent": {
      "command": "npx",
      "args": [
        "-y",
        "@confluentinc/mcp-confluent",
        "--config",
        "/path/to/config.yaml"
      ]
    }
  }
}
```

See [CONFIGURATION.md](../CONFIGURATION.md) for what to put in `config.yaml`, and the [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/cascade/mcp) for client-side details. Legacy env-var configuration (`-e /path/to/config.env`) still works during the deprecation window.
