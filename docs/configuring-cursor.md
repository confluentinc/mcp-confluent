# Configuring Cursor

Add the MCP server to your Cursor configuration at `~/.cursor/mcp.json`:

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

See [CONFIGURATION.md](../CONFIGURATION.md) for what to put in `config.yaml`, and the [Cursor MCP documentation](https://cursor.com/docs/mcp) for client-side details. Legacy env-var configuration (`-e /path/to/config.env`) still works during the deprecation window.
