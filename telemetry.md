# Telemetry and Usage Data

_Last updated: May 2026_

The Confluent MCP Server collects usage data to help us understand how the server is used and improve the user experience.

## How to Control Telemetry

Telemetry can be disabled by setting the `DO_NOT_TRACK` environment variable to `true`:

```bash
DO_NOT_TRACK=true
```

Or, in a YAML config, set `server.do_not_track: true`. The `DO_NOT_TRACK` env
var always wins over the YAML field — it's the floor, so opting out in the
environment cannot be overridden by a stray `false` in a config file.

When telemetry is disabled, no events are sent.

## What Events Are Tracked

The server tracks tool call completions and failures, server startup, and Confluent Cloud authentication outcomes.

### Captured Information

- Tool name, execution duration, and success/error status
- Confluent Cloud authentication outcome (success or failure reason). Successful logins also include `ccloudUserId` (the user's Confluent Cloud `resource_id`) and `ccloudDomain` (the domain portion of the user's email).

### Context Information (Sent with All Events)

- Server session ID (random, per-process)
- Server version and transport type
- Connected MCP client name and version
- OS platform, version, and architecture

A randomly generated machine ID is persisted in `~/.mcp-confluent/machine-id` and used as the anonymous user identifier.

## Questions or Concerns?

If you have questions about telemetry or privacy:

- **File an Issue:** [GitHub Issues](https://github.com/confluentinc/mcp-confluent/issues)
- **Review the Code:** [Telemetry Source Code](https://github.com/confluentinc/mcp-confluent/blob/main/src/confluent/telemetry.ts)
- **See Full Privacy Policy:** [Confluent Privacy Notice (July 2025)](https://www.confluent.io/confluent-privacy-statement/)
