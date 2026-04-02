# Configuring Gemini CLI

For detailed information about Gemini CLI extensions and MCP servers, please refer to the official documentation:

- [Gemini CLI Extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extension.md)
- [Gemini CLI MCP Server Tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

Here's how to get `mcp-confluent` running with Gemini CLI:

1. **Install Gemini CLI:**
   If you haven't already, install the Gemini CLI. You can find installation instructions on the [official GitHub repository](https://github.com/google-gemini/gemini-cli).

2. **Install the `mcp-confluent` Extension:**

   ```bash
   gemini extensions install https://github.com/confluentinc/mcp-confluent
   # Navigate to the root directory of this project (where `gemini-extension.json` is located) and run:
   # gemini extensions install .
   ```

   This command registers the `mcp-confluent` server with Gemini CLI and creates a dedicated directory for it under `~/.gemini/extensions/mcp-confluent`.

3. **Provide Environment Variables:**
   The extension requires your Confluent Cloud credentials and configuration to be available in a `.env` file.
   - First, ensure you have a correctly populated `.env` file in the root of this project. For instructions, see the [Configuration](../README.md#configuration) section.
   - Next, copy your `.env` file into the extension's directory so Gemini CLI can access it (the Gemini extension expects the `.env` file at `${extensionPath}${pathSeparator}.env`; see [the variables documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md#variables) for details):

   ```bash
   cp .env ~/.gemini/extensions/mcp-confluent/.env
   ```

4. **Verify and Use:**
   You can now start using the Confluent tools via Gemini CLI. To verify that the tools are available, you can list them:

   ```bash
   gemini -l
   # or `gemini extensions list`
   ```

   And here's an example of invoking a tool:

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
