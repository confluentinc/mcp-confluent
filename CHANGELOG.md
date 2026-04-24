# Confluent's Local / OSS MCP Server

All notable changes to this MCP server will be documented in this file.

## Unreleased

### Changed

- Removed `baseUrl` invocation parameter from all tool definitions. Now any API non-defaulting endpoint URLs must be provided through environment variable configuration prior to MCP server startup.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) for all tools to enable AI clients to distinguish between read-only operations (e.g., `list-topics`) and destructive operations (e.g., `delete-topics`, `delete-schema`).

### Added

- Configuration via YAML file.
  - Details go here eventually.
- `config.example.yaml` template for YAML-based configuration. Users copy it to `config.yaml` to use; a blanket `/*.{yaml,yml}` `.gitignore` rule (with explicit allow-rules for currently-tracked root files) keeps personal configs and any other accidental root-level yaml out of git.

## 1.2.1

### Fixed

- Fixed telemetry configuration for production builds

## 1.2.0

### Added

- Confluent Cloud metrics API tools
- Telemetry setup and tool call event tracking
- Local Kafka and Schema Registry connections (most tools now work without `*_API_KEY / *_API_SECRET`, enabling functionality in local dev environments)
- `delete-schema` tool for Schema Registry
- Flink catalog tools and diagnostic capabilities
- `list-billing-costs` tool for Confluent Billing API
- Initial test configuration and SonarQube coverage tracking

### Changed

- Improved README with tools table, local dev section, and client config docs
- Updated package dependencies
