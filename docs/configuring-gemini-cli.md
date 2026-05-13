# Configuring Gemini CLI

For detailed information about Gemini CLI extensions and MCP servers:

- [Gemini CLI Extensions](https://geminicli.com/docs/extensions/)
- [Gemini CLI MCP Server Tools](https://geminicli.com/docs/cli/tutorials/mcp-setup/#how-to-configure-gemini-cli)

Here's how to get `mcp-confluent` running with Gemini CLI:

1. **Install Gemini CLI:**
   If you haven't already, install the Gemini CLI. You can find installation instructions on the [official GitHub repository](https://github.com/google-gemini/gemini-cli).

2. **Install the `mcp-confluent` extension:**

   ```bash
   gemini extensions install https://github.com/confluentinc/mcp-confluent
   # Or, from a local checkout (the directory containing gemini-extension.json):
   # gemini extensions install .
   ```

   This registers the `mcp-confluent` server with Gemini CLI and creates a dedicated directory under `~/.gemini/extensions/mcp-confluent`.

3. **Provide credentials and config:**

   The shipped Gemini extension currently invokes the MCP server with `-e ${extensionPath}${pathSeparator}.env` — that is, the **legacy env-var configuration path** with a `.env` file at a fixed location inside the extension directory. A future extension release will switch to the YAML path; until then, populate that `.env`:

   ```bash
   cp /path/to/your/.env ~/.gemini/extensions/mcp-confluent/.env
   ```

   See [CONFIGURATION.md → Legacy env-var configuration](../CONFIGURATION.md#legacy-env-var-configuration-deprecated) for the variable reference. The same file can also carry `${VAR}` values that a future YAML config would interpolate, so any setup work you do here carries forward.

4. **Verify and use:**

   ```bash
   gemini -l
   # or `gemini extensions list`
   ```

   Example session:

   ```bash

   gemini
   ....

   🟢 mcp-confluent (from mcp-confluent) - Ready (24 tools)
   ....

   Using: 1 MCP server (ctrl+t to toggle)
   ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
   │ > list topics                                                                                                                                             │
   ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

   ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
   │ ✓  list-topics (mcp-confluent MCP Server) {}                                                                                                       │
   │                                                                                                                                                    │
   │    Kafka topics:                                                                                                                                   │
   │    products_summarized,products,topic_8,products_summarized_with_embeddings,elastic_minimized,user_message_related_products,user_message_embeddin  │
   │    gs,dlq-lcc-d3738o,user_message,elastic                                                                                          │
   ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
   ✦ Okay, I see the following topics: products_summarized, products, topic_8, products_summarized_with_embeddings, elastic_minimized,
     user_message_related_products, user_message_embeddings, dlq-lcc-d3738o, user_message, and elastic.

   ```
