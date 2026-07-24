# Telemetry and Usage Data

_Last updated: May 2026_

The Confluent MCP Server collects usage data to understand how it is used, and reports server-side runtime errors to [Sentry](https://sentry.io) so we can detect and fix problems you hit while running it.

## How to Control Telemetry

A single switch turns off **both** usage analytics and error reporting. Either source opts you out:

- `DO_NOT_TRACK=true` (environment variable)
- `server.do_not_track: true` (YAML config)

When opted out, no usage events are sent and Sentry never initializes — no DSN is registered, no error handlers are attached.

## What Events Are Tracked

The server tracks tool call completions and failures, server startup, Confluent Cloud authentication outcomes, and clicks on the "Copy" button next to the agent-skills install command on the OAuth success page.

### Captured Information

- Tool name, execution duration, and success/error status
- Confluent Cloud authentication outcome (success or failure reason).
  Successful logins also include `ccloudUserId` (the user's Confluent Cloud `resource_id`) and `ccloudDomain` (the domain portion of the user's email).
- Clicks on the "Copy" button for the agent-skills install command on the OAuth success page.
  The event itself carries no payload.
  Because this click can only happen after a successful login, it is attributable to the same `ccloudUserId` recorded by the preceding authentication event, alongside the shared context information below.

### Context Information (Sent with All Events)

- Server session ID (random, per-process)
- Server version and transport type
- Connected MCP client name and version
- OS platform, version, and architecture

A randomly generated machine ID is persisted in `~/.mcp-confluent/machine-id` and used as the anonymous user identifier.

## Error Reporting (Sentry)

**Enabled by default** in published builds, governed by the same `DO_NOT_TRACK` switch above.
Inactive in local/source builds (they ship without a DSN).

**Reported:** uncaught exceptions, unhandled rejections, and errors thrown by a tool handler (tagged with the tool name) — with the error type, message, TypeScript-resolved stack trace, server version, transport, and connection types.

**Never reported:** Confluent credentials.
Before any event is sent, a redaction step scrubs `Authorization`/`Bearer`/`Basic` header values, Confluent API-key/secret values, SASL passwords, and secrets in YAML payloads; HTTP bodies and local variables are not collected at all.

## Questions or Concerns?

If you have questions about telemetry or privacy:

- **File an Issue:** [GitHub Issues](https://github.com/confluentinc/mcp-confluent/issues)
- **Review the Code:** [Telemetry Source Code](https://github.com/confluentinc/mcp-confluent/blob/main/src/confluent/telemetry.ts)
- **See Full Privacy Policy:** [Confluent Privacy Notice (July 2025)](https://www.confluent.io/confluent-privacy-statement/)
