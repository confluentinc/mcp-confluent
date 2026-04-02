# Configuring Claude Code

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) supports MCP servers natively. Add the server to your project configuration:

```bash
claude mcp add confluent -- npx -y @confluentinc/mcp-confluent -e /path/to/.env
```

Or add it to your `.mcp.json` file directly:

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
