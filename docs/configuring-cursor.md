# Configuring Cursor

Add the MCP server to your Cursor configuration at `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "confluent": {
      "command": "npx",
      "args": ["-y", "@confluentinc/mcp-confluent", "-e", "/path/to/.env"]
    }
  }
}
```

See the [Cursor MCP documentation](https://cursor.com/docs/mcp) for more details.
