# Configuring VS Code

Add the MCP server to your VS Code user settings (`settings.json`) or workspace `.vscode/mcp.json`:

```json
{
  "servers": {
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

See [CONFIGURATION.md](../CONFIGURATION.md) for what to put in `config.yaml`, and the [VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/chat/mcp-servers) for client-side details. Legacy env-var configuration (`-e /path/to/config.env`) still works during the deprecation window.

For starting and restarting the server within VS Code, open the `mcp.json` settings file and use the IDE's built-in codelens actions.
