# Telemetry and Usage Data

*Last updated: March 2026*

The Confluent MCP Server collects anonymous usage data to help us understand how the server is used and improve the user experience.

## How to Control Telemetry

Telemetry can be disabled by setting the `DO_NOT_TRACK` environment variable to `true`:

```bash
DO_NOT_TRACK=true
```

When telemetry is disabled, no events are sent.

## What Events Are Tracked

The server tracks tool call completions and failures, including the tool name, duration, and error details when applicable.

### Captured Information

- Tool name and execution duration
- Success or failure status
- Error type and message (on failure, truncated)

### Context Information (Sent with All Events)

- Server session ID (random, per-process)
- Server version and transport type
- Connected MCP client name and version
- OS platform, version, and architecture

A randomly generated machine ID is persisted in `~/.mcp-confluent/machine-id` and used as the anonymous user identifier. No personally identifiable information is collected.

## Questions or Concerns?

If you have questions about telemetry or privacy:

- **File an Issue:** [GitHub Issues](https://github.com/confluentinc/mcp-confluent/issues)
- **Review the Code:** [Telemetry Source Code](https://github.com/confluentinc/mcp-confluent/blob/main/src/confluent/telemetry.ts)
- **See Full Privacy Policy:** [Confluent Privacy Notice (July 2025)](https://www.confluent.io/confluent-privacy-statement/)
