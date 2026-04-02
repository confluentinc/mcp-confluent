# Configuring Windsurf

Add the MCP server to your Windsurf configuration at `~/.codeium/windsurf/mcp_config.json`:

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

See the [Windsurf MCP documentation](https://docs.windsurf.com/windsurf/mcp) for more details.
