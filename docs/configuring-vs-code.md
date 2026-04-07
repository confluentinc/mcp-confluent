# Configuring VS Code

Add the MCP server to your VS Code user settings (`settings.json`) or workspace `.vscode/mcp.json`:

```json
{
  "mcp": {
    "servers": {
      "confluent": {
        "command": "npx",
        "args": ["-y", "@confluentinc/mcp-confluent", "-e", "/path/to/.env"]
      }
    }
  }
}
```

See the [VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for more details.
