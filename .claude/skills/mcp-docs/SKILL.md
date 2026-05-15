---
name: mcp-docs
description:
  Use when the user asks about Model Context Protocol details (protocol spec, transports,
  authorization, tools/resources/prompts, sampling/elicitation/roots, server/client concepts,
  extensions, or SDK usage). Triggers on phrases like "MCP spec", "MCP transport",
  "streamable HTTP", "MCP authorization", "list_tools", "initialize handshake", "MCP SDK",
  "@modelcontextprotocol/sdk", or "how does MCP X".
allowed-tools:
  - WebFetch
  - WebSearch
  - Read
  - Grep
---

# MCP Protocol Documentation Lookup

Look up Model Context Protocol (MCP) documentation from modelcontextprotocol.io.

## Instructions

You are looking up MCP protocol documentation to answer a question or guide implementation.

### Step 1: Fetch the documentation index

Fetch the machine-readable index at `https://modelcontextprotocol.io/llms.txt`. This lists all ~90
documentation pages with titles and URLs. Use it to identify which page(s) are relevant to the
question.

### Step 2: Fetch the relevant page(s)

Append `.md` to page URLs for cleaner markdown content. For example:

- `https://modelcontextprotocol.io/docs/learn/architecture.md`
- `https://modelcontextprotocol.io/specification/2025-11-25/server/tools.md`

Fetch only the pages needed to answer the question — typically 1-3 pages.

### Step 3: Cross-reference with our codebase

When relevant, use Read and Grep to cross-reference the documentation with our implementation in
`src/` to provide concrete, project-specific guidance.

## Documentation Tiers

Use these categories to prioritize which pages to fetch:

- **Specification** (`/specification/2025-11-25/...`) — Protocol-level details: transports,
  lifecycle, tools, resources, prompts, pagination, logging. Prioritize for questions about MCP
  server implementation, protocol behavior, or message formats.

- **Develop guides** (`/docs/develop/...`) — Building servers/clients, connecting local/remote
  servers. Prioritize for integration, setup, or "how do I build..." questions.

- **Learn** (`/docs/learn/...`) — Architecture, core concepts, server/client roles. Prioritize for
  conceptual or "how does MCP work" questions.

- **SDK** (`/docs/sdk.md`) — SDK reference. Relevant when working with `@modelcontextprotocol/sdk`
  APIs.

- **Extensions** (`/extensions/...`) — Auth, application support, client compatibility matrix.
  Relevant for auth and transport questions.
