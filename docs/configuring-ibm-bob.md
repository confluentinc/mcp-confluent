# Configuring IBM Bob

[IBM Bob](https://bob.ibm.com/) supports MCP servers via `mcp_settings.json`.
Add the server to `/Users/{user_name}/.bob/settings/mcp_settings.json`:

```json
{
  "mcpServers": {
    "confluent": {
      "command": "npx",
      "args": [
        "-y",
        "@confluentinc/mcp-confluent",
        "-c",
        "/Users/username/path-to-config/myconfig.yaml"
      ]
    }
  }
}
```

See [CONFIGURATION.md](../CONFIGURATION.md) for what to put in `config.yaml`. Legacy env-var configuration (`-e /path/to/config.env`) still works during the deprecation window.
