# Confluent's Local / OSS MCP Server

All notable changes to this MCP server will be documented in this file.

## Unreleased

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
