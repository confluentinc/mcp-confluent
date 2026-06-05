# Configuring the Confluent MCP Server

This is the single reference for configuring mcp-confluent.
It covers the YAML config file (`-c config.yaml`), the legacy env-var path (`-e config.env`) that the server still accepts during the transition, and how the two interact via `${VAR}` interpolation.

## Contents

- [Two paths, one configuration](#two-paths-one-configuration)
- [Quick start (YAML)](#quick-start-yaml)
- [Anatomy of a YAML config](#anatomy-of-a-yaml-config)
- [`${VAR}` interpolation](#var-interpolation)
- [How env vars and `.env` files fit into the YAML world](#how-env-vars-and-env-files-fit-into-the-yaml-world)
- [Authentication modes](#authentication-modes)
- [HTTP/SSE transport security](#httpsse-transport-security)
- [Tool enablement: which block lights up what](#tool-enablement-which-block-lights-up-what)
- [Legacy env-var configuration (deprecated)](#legacy-env-var-configuration-deprecated)
- [Future plans](#future-plans)
- [Troubleshooting](#troubleshooting)

## Two paths, one configuration

mcp-confluent accepts configuration through either of two entry points, both of which feed the same internal configuration model at startup:

| Path              | Invocation                                                | Status                |
| ----------------- | --------------------------------------------------------- | --------------------- |
| YAML              | `-c path/to/config.yaml`                                  | **Preferred.**        |
| Env vars (legacy) | `-e path/to/config.env` _or_ exported in the parent shell | Accepted; deprecated. |

The two paths are mutually exclusive: if you pass `-c`, the YAML file is the source of truth; otherwise the server reads the legacy environment variables listed in [Legacy env-var configuration](#legacy-env-var-configuration-deprecated).

**Roadmap.** The two paths have full parity today.
In a near-future release the env-var-only path will emit a startup warning; a release or two later it will be removed.

If you are starting fresh, begin with YAML.
If you have an existing `.env`, [migrate when convenient](#legacy-env-var-configuration-deprecated) — both `-c` and `-e` continue to work for now.

## Quick start (YAML)

```bash
# 1. Drop a starter config.yaml into the current directory.
npx @confluentinc/mcp-confluent --init-config

# 2. Edit ./config.yaml — fill in the blocks you need.

# 3. Start the server.
npx @confluentinc/mcp-confluent --config ./config.yaml
```

`--init-config` copies [`config.example.yaml`](config.example.yaml) into `./config.yaml` and idempotently appends the filename to a sibling `.gitignore` so secrets cannot slip into a commit.
It refuses to overwrite an existing `config.yaml`.

For OAuth-only setups use `--init-oauth-config` instead; it drops [`config.oauth.example.yaml`](config.oauth.example.yaml) at the same destination.
The two flags are mutually exclusive.

## Anatomy of a YAML config

A config picks one of two connection flavors — OAuth or direct — and optionally adds a top-level `server:` block for transport/security/logging settings.
The fully annotated reference is [`config.example.yaml`](config.example.yaml); per-field comments live there rather than being duplicated here.
Compact examples for common local-Docker setups live in [`sample_configs/`](sample_configs/).

### OAuth connection (`type: oauth`)

Confluent Cloud login via PKCE: the browser opens on the first tool call that needs Cloud access, the resulting session is reused for the rest of the process, and there are no API keys to provision.
The connection itself carries no service blocks — resource IDs (cluster, env) flow in as tool arguments at call time.

```yaml
server:
  transports: [stdio]
  log_level: info

connections:
  ccloud-oauth:
    type: oauth
```

Get a starter file via `--init-oauth-config`.
Not every tool is OAuth-eligible yet — see [Authentication modes](#authentication-modes) for the supported list.

### Direct connection (`type: direct`)

Credentials live in the YAML — API key/secret per service block, typically `${VAR}`-interpolated from your shell environment.
Each service block under the connection is independently optional: include the ones you need and omit the rest.
The [tools that depend on missing blocks disable themselves](#tool-enablement-which-block-lights-up-what).
At least one service block must remain.

```yaml
server:
  transports: [stdio]
  log_level: info

connections:
  default:
    type: direct
    kafka: { ... }
    schema_registry: { ... }
    confluent_cloud: { ... }
    flink: { ... }
    tableflow: { ... }
    telemetry: { ... }
```

The connection name (`default` above) is freeform.

#### Service blocks

| Block             | Purpose                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kafka`           | Bootstrap address + auth for the native Kafka admin/producer/consumer client; REST endpoint + cluster/env IDs for REST-proxy tools.                                                     |
| `schema_registry` | Endpoint + auth for Confluent Schema Registry.                                                                                                                                          |
| `confluent_cloud` | Endpoint + auth for the Confluent Cloud control plane (environments, clusters, connectors, billing, catalog).                                                                           |
| `flink`           | Endpoint + auth + IDs for Flink SQL and the Flink catalog. All five of `endpoint`, `auth`, `environment_id`, `organization_id`, `compute_pool_id` are required if the block is present. |
| `tableflow`       | Auth for Tableflow topic and catalog-integration tools. Pairs with `confluent_cloud` for environment/cluster lookups.                                                                   |
| `telemetry`       | Endpoint + auth for the Metrics API. Optional override; defaults inherit from `confluent_cloud.auth`.                                                                                   |

Field-level details, defaults, and which CLI/env-var each field replaces are in [`config.example.yaml`](config.example.yaml).

### The common `server:` block

Both connection flavors above accept the same top-level `server:` block.
It is entirely optional — omit it to accept the same defaults today's env-var users get.
The fully annotated example is in [`config.example.yaml`](config.example.yaml); when present, it replaces these env vars:

| Field                              | Replaces env var                                                      |
| ---------------------------------- | --------------------------------------------------------------------- |
| `server.transports`                | `--transport` CLI flag                                                |
| `server.log_level`                 | `LOG_LEVEL`                                                           |
| `server.do_not_track`              | `DO_NOT_TRACK` (env wins as the floor; see [Telemetry](telemetry.md)) |
| `server.http.port`                 | `HTTP_PORT`                                                           |
| `server.http.host`                 | `HTTP_HOST`                                                           |
| `server.http.mcp_endpoint`         | `HTTP_MCP_ENDPOINT_PATH`                                              |
| `server.http.sse_endpoint`         | `SSE_MCP_ENDPOINT_PATH`                                               |
| `server.http.sse_message_endpoint` | `SSE_MCP_MESSAGE_ENDPOINT_PATH`                                       |
| `server.auth.api_key`              | `MCP_API_KEY`                                                         |
| `server.auth.allowed_hosts`        | `MCP_ALLOWED_HOSTS`                                                   |
| `server.auth.disabled`             | `MCP_AUTH_DISABLED` / `--disable-auth`                                |

`server.transports` and the `--transport` CLI flag are mutually exclusive — declare transports in YAML or on the command line, not both.

## `${VAR}` interpolation

YAML values support `${VAR}` and `${VAR:-default}` substitution, so secrets can live in your shell environment (or a `-e` dotenv) while structure lives in the file:

```yaml
connections:
  production:
    type: direct
    kafka:
      bootstrap_servers: "broker.confluent.cloud:9092"
      auth:
        type: api_key
        key: "${KAFKA_API_KEY}"
        secret: "${KAFKA_API_SECRET}"
```

A missing variable with no `:-default` is a parse-time error.
Plain literals also work; interpolation is a convenience, not a requirement.

## How env vars and `.env` files fit into the YAML world

Even after the legacy env-var-only configuration path retires, env vars keep doing real work for mcp-confluent.
They have **three jobs** with different lifecycles — keep them straight when you read the rest of this document:

1. **Interpolation source for `${VAR}` in YAML.** _Long-term supported._ This is the recommended way to keep secrets out of version control: structure in `config.yaml`, secrets in your environment (or a dotenv loaded via `-e`).
2. **Linked-library passthrough.** _Long-term supported._ Several libraries mcp-confluent depends on read environment variables directly — OpenSSL (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, ...), cyrus-sasl (`SASL_PATH`), krb5 (`KRB5_CONFIG`, `KRB5CCNAME`, ...), undici (`HTTPS_PROXY`, `NO_PROXY`, ...).
   There is no YAML knob for these; they have to reach the server as env vars.
3. **Sole configuration source on the legacy path.** _Deprecated; will be removed in a near-future release._ This is what happens when you start the server without `-c` — every `KAFKA_API_KEY`, `FLINK_REST_ENDPOINT`, etc. listed in [Legacy env-var configuration](#legacy-env-var-configuration-deprecated) is serving this job today and only this job.

The `-e <file>` CLI flag loads a dotenv file into the server's environment once, at startup, and the resulting values then feed all three jobs above.
Same flag, three lifecycles:

```bash
# Job 1 only: YAML structure, secrets and linked-library vars in the dotenv.
npx @confluentinc/mcp-confluent -c config.yaml -e secrets.env

# Jobs 1 + 2: same as above; linked-library vars in the same dotenv.
npx @confluentinc/mcp-confluent -c config.yaml -e env-with-tls-and-secrets.env

# Job 3 (legacy): no -c, the server reads every known var from the dotenv.
npx @confluentinc/mcp-confluent -e legacy.env
```

> **Caveat — dynamic-linker vars.** `LD_LIBRARY_PATH`, `LD_PRELOAD`, macOS `DYLD_*`, and anything else consumed before Node starts cannot be set via `-e`.
> Set those in the shell that launches mcp-confluent.

## Authentication modes

Two `type:` values on a connection, with different ergonomics:

### `type: direct` — API keys in YAML

Each service block carries its own `auth: { type: api_key, key, secret }`.
The keys can live in YAML literals (fine for local dev), or — much more commonly — `${VAR}` interpolated from the environment:

```yaml
connections:
  prod:
    type: direct
    confluent_cloud:
      auth:
        type: api_key
        key: "${CONFLUENT_CLOUD_API_KEY}"
        secret: "${CONFLUENT_CLOUD_API_SECRET}"
```

### `type: oauth` — Confluent Cloud login (PKCE)

The big new feature of this release.
The server opens the Confluent Cloud sign-in page in your browser on the first tool call that needs Cloud access; the resulting session is reused for the rest of the process.
No API keys to provision.

```yaml
connections:
  ccloud-oauth:
    type: oauth
```

OAuth connections carry no service blocks.
Resource IDs (cluster_id, environment_id, ...) that direct-mode connections pin in YAML instead flow in as tool arguments at call time.
Get a starter file via `--init-oauth-config`.

**OAuth-eligible tools.** Not every tool has been migrated to OAuth yet — REST-only categories (Connect, Tableflow, Flink, Metrics, Catalog & Tags) still require `type: direct`.
The currently-supported list:

| Category                               | Tools                                                                                  | Notes                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka (native)                         | `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages` | Pass `cluster_id` + `environment_id` as arguments. Schema Registry serialization works on produce/consume for `AVRO` and `JSON`; `PROTOBUF` is currently broken across the board ([issue #127](https://github.com/confluentinc/mcp-confluent/issues/127)) and will not be fixed for this release. |
| Kafka REST                             | `get-topic-config`, `alter-topic-config`                                               | Pass `clusterId` + `environmentId` as arguments.                                                                                                                                                                                                                                                  |
| Schema Registry                        | `list-schemas`, `delete-schema`                                                        | Pass `environment_id`; the SR cluster and endpoint are auto-resolved.                                                                                                                                                                                                                             |
| Organizations, Environments & Clusters | `list-organizations`, `list-environments`, `read-environment`, `list-clusters`         | —                                                                                                                                                                                                                                                                                                 |
| Billing                                | `list-billing-costs`                                                                   | —                                                                                                                                                                                                                                                                                                 |

## HTTP/SSE transport security

HTTP and SSE transports require API-key authentication by default to prevent unauthorized access and DNS rebinding.
Enable them by listing them in `server.transports` (or via `--transport http,sse`); auth is on unless you explicitly opt out.

### Generating an API key

```bash
npx @confluentinc/mcp-confluent --generate-key
```

Add the result to `server.auth.api_key`:

```yaml
server:
  transports: [http]
  auth:
    api_key: "${MCP_API_KEY}"
```

Clients pass it in the `cflt-mcp-api-key` header on every request:

```bash
curl -H "cflt-mcp-api-key: $MCP_API_KEY" http://localhost:8080/mcp
```

### DNS-rebinding protection

The server validates the `Host` header against `server.auth.allowed_hosts` (default: `[localhost, 127.0.0.1]`):

```yaml
server:
  auth:
    allowed_hosts: [localhost, 127.0.0.1, myhost.local]
```

It also binds to `127.0.0.1` by default — set `server.http.host` to expose it elsewhere.

### Disabling auth (development only)

```yaml
server:
  auth:
    disabled: true
```

Or use `--disable-auth` on the command line. **Never** disable auth in production or when the server is network-accessible.

## Tool enablement: which block lights up what

Tools auto-enable based on which service blocks are present in the resolved configuration.
Run `--list-tools` to see the live set for your config, or use the `explain-disabled-tools` MCP tool to ask the running server why a specific tool is missing.

| Block(s) required                                        | Tools enabled                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| (always on)                                              | `search-product-docs`, `get-product-doc-page`, `explain-disabled-tools`, `list-connections`                                                                                                                                                                                                                                                                  |
| `kafka` with `bootstrap_servers` _or_ `type: oauth`      | `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages`                                                                                                                                                                                                                                                                       |
| `kafka` with `rest_endpoint` + `auth` _or_ `type: oauth` | `get-topic-config`, `alter-topic-config`                                                                                                                                                                                                                                                                                                                     |
| `schema_registry` _or_ `type: oauth`                     | `list-schemas`, `delete-schema`                                                                                                                                                                                                                                                                                                                              |
| `flink`                                                  | `create-flink-statement`, `list-flink-statements`, `read-flink-statement`, `delete-flink-statements`, `get-flink-statement-exceptions`, `check-flink-statement-health`, `detect-flink-statement-issues`, `list-flink-catalogs`, `list-flink-databases`, `list-flink-tables`, `describe-flink-table`, `get-flink-table-info`                                  |
| `flink` + `telemetry`                                    | `get-flink-statement-profile`                                                                                                                                                                                                                                                                                                                                |
| `tableflow`                                              | `create-tableflow-topic`, `list-tableflow-topics`, `read-tableflow-topic`, `update-tableflow-topic`, `delete-tableflow-topic`, `list-tableflow-regions`, `create-tableflow-catalog-integration`, `list-tableflow-catalog-integrations`, `read-tableflow-catalog-integration`, `update-tableflow-catalog-integration`, `delete-tableflow-catalog-integration` |
| `confluent_cloud` _or_ `type: oauth`                     | `list-organizations`, `list-environments`, `read-environment`, `list-clusters`, `list-billing-costs`                                                                                                                                                                                                                                                         |
| `confluent_cloud` (direct only)                          | `list-connectors`, `get-connector-config`, `get-connector-offsets`, `get-connector-status`, `get-connector-tasks`, `get-connector-error-summary`, `get-connector-error-recommendations`, `get-connector-logs`, `delete-connector`, `pause-connector`, `resume-connector`, `restart-connector`, `update-connector-config`                                     |
| `confluent_cloud` + `kafka.auth` (direct only)           | `create-connector`                                                                                                                                                                                                                                                                                                                                           |
| `schema_registry` with api-key auth (direct only)        | `search-topics-by-tag`, `search-topics-by-name`, `create-topic-tags`, `delete-tag`, `remove-tag-from-entity`, `add-tags-to-topic`, `list-tags`                                                                                                                                                                                                               |
| `telemetry`                                              | `list-available-metrics`, `query-metrics`                                                                                                                                                                                                                                                                                                                    |

## Legacy env-var configuration (deprecated)

> If you are starting fresh, skip this section — use [Quick start (YAML)](#quick-start-yaml) instead.
>
> **What "deprecated" means here.** Setting credentials and endpoints purely via env vars (job 3 in [How env vars and `.env` files fit into the YAML world](#how-env-vars-and-env-files-fit-into-the-yaml-world)) will emit a startup warning in a near-future release and be removed a release or two later.
> Using env vars to **feed `${VAR}` interpolation in YAML** (job 1) and to **pass through linked-library settings** (job 2) is long-term supported and unaffected.

Run the server without `-c` and these variables, read either from the parent shell or from a `-e <file>` dotenv, populate the same internal configuration the YAML path would build.

<details>
<summary>Show full variable list</summary>

| Variable                      | Description                                                                                                                                                                                                                     | Default                                 | Required                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------ |
| HTTP_HOST                     | Host to bind for HTTP transport. Defaults to localhost only for security.                                                                                                                                                       | `127.0.0.1`                             | No                                   |
| HTTP_MCP_ENDPOINT_PATH        | HTTP endpoint path for MCP transport (e.g. `/mcp`).                                                                                                                                                                             | `/mcp`                                  | No                                   |
| HTTP_PORT                     | Port to use for HTTP transport.                                                                                                                                                                                                 | `8080`                                  | No                                   |
| LOG_LEVEL                     | Log level for application logging (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).                                                                                                                                         | `info`                                  | No                                   |
| MCP_API_KEY                   | API key for HTTP/SSE authentication. Generate with `--generate-key`. Required when auth is enabled.                                                                                                                             |                                         | If HTTP/SSE without `--disable-auth` |
| MCP_AUTH_DISABLED             | Disable authentication for HTTP/SSE transports. **Development only.**                                                                                                                                                           | `false`                                 | No                                   |
| MCP_ALLOWED_HOSTS             | Comma-separated `Host` header allowlist for DNS rebinding protection.                                                                                                                                                           | `localhost,127.0.0.1`                   | No                                   |
| SSE_MCP_ENDPOINT_PATH         | SSE endpoint path for establishing SSE connections.                                                                                                                                                                             | `/sse`                                  | No                                   |
| SSE_MCP_MESSAGE_ENDPOINT_PATH | SSE endpoint path for receiving messages.                                                                                                                                                                                       | `/messages`                             | No                                   |
| BOOTSTRAP_SERVERS             | Comma-separated Kafka broker addresses (`host1:port1,host2:port2`).                                                                                                                                                             |                                         | For Kafka tools                      |
| CONFLUENT_CLOUD_API_KEY       | Confluent Cloud control-plane API key.                                                                                                                                                                                          |                                         | For CCloud tools                     |
| CONFLUENT_CLOUD_API_SECRET    | Confluent Cloud control-plane API secret.                                                                                                                                                                                       |                                         | For CCloud tools                     |
| CONFLUENT_CLOUD_REST_ENDPOINT | Base URL for Confluent Cloud's REST API.                                                                                                                                                                                        | `https://api.confluent.cloud`           | No                                   |
| FLINK_API_KEY                 | Confluent Cloud Flink API key.                                                                                                                                                                                                  |                                         | For Flink tools                      |
| FLINK_API_SECRET              | Confluent Cloud Flink API secret.                                                                                                                                                                                               |                                         | For Flink tools                      |
| FLINK_CATALOG_NAME            | Flink catalog name used as `sql.current-catalog`. Typically the CCloud environment's display name.                                                                                                                              |                                         | No                                   |
| FLINK_COMPUTE_POOL_ID         | Flink compute pool ID; must start with `lfcp-`.                                                                                                                                                                                 |                                         | For Flink tools                      |
| FLINK_DATABASE_NAME           | Default Flink database, used as `sql.current-database`.                                                                                                                                                                         |                                         | No                                   |
| FLINK_ENV_ID                  | Flink environment ID; must start with `env-`.                                                                                                                                                                                   |                                         | For Flink tools                      |
| FLINK_ENV_NAME                | **Deprecated** (removed in v1.4.0). Use `FLINK_CATALOG_NAME` instead.                                                                                                                                                           |                                         | No                                   |
| FLINK_ORG_ID                  | Confluent Cloud organization ID.                                                                                                                                                                                                |                                         | For Flink tools                      |
| FLINK_REST_ENDPOINT           | Base URL for Confluent Cloud's Flink REST API.                                                                                                                                                                                  |                                         | For Flink tools                      |
| KAFKA_API_KEY                 | Kafka SASL username.                                                                                                                                                                                                            |                                         | For authenticated Kafka              |
| KAFKA_API_SECRET              | Kafka SASL password.                                                                                                                                                                                                            |                                         | For authenticated Kafka              |
| KAFKA_CLUSTER_ID              | Kafka cluster ID within Confluent Cloud.                                                                                                                                                                                        |                                         | For Kafka REST tools                 |
| KAFKA_ENV_ID                  | Environment ID for the Kafka cluster; must start with `env-`.                                                                                                                                                                   |                                         | For Kafka REST tools                 |
| KAFKA_REST_ENDPOINT           | REST endpoint for Kafka cluster management.                                                                                                                                                                                     |                                         | For Kafka REST tools                 |
| SCHEMA_REGISTRY_API_KEY       | Schema Registry API key.                                                                                                                                                                                                        |                                         | For Schema Registry tools            |
| SCHEMA_REGISTRY_API_SECRET    | Schema Registry API secret.                                                                                                                                                                                                     |                                         | For Schema Registry tools            |
| SCHEMA_REGISTRY_ENDPOINT      | Schema Registry endpoint URL.                                                                                                                                                                                                   |                                         | For Schema Registry tools            |
| TABLEFLOW_API_KEY             | Tableflow API key.                                                                                                                                                                                                              |                                         | For Tableflow tools                  |
| TABLEFLOW_API_SECRET          | Tableflow API secret.                                                                                                                                                                                                           |                                         | For Tableflow tools                  |
| TELEMETRY_ENDPOINT            | Base URL for the Confluent Cloud Telemetry (Metrics) API.                                                                                                                                                                       | `https://api.telemetry.confluent.cloud` | No                                   |
| TELEMETRY_API_KEY             | Telemetry API key; falls back to `CONFLUENT_CLOUD_API_KEY` if unset. See the [Metrics API auth docs](https://docs.confluent.io/cloud/current/monitoring/metrics-api.html#create-an-api-key-to-authenticate-to-the-metrics-api). |                                         | No                                   |
| TELEMETRY_API_SECRET          | Telemetry API secret; falls back to `CONFLUENT_CLOUD_API_SECRET` if unset.                                                                                                                                                      |                                         | No                                   |
| DO_NOT_TRACK                  | Set to `true` to opt out of anonymous telemetry. See [Telemetry](telemetry.md). Wins over `server.do_not_track` in YAML.                                                                                                        |                                         | No                                   |

</details>

To migrate, run `--init-config`, then translate each variable you currently set into the matching block from [`config.example.yaml`](config.example.yaml).
For a side-by-side, every `${VAR:-...}` placeholder in `config.example.yaml` names the env var that field used to come from.
You can keep secrets in your existing `.env` and reference them via `${VAR}` from the YAML — that is job 1 above, and is the recommended migration target.

## Future plans

The configuration schema accepts multiple named entries under `connections:` and the YAML parser validates them, but today the server expects exactly one.
Once the rest of the runtime catches up, a single `config.yaml` will be able to point at several Confluent Cloud or local clusters at the same time; you will not need to restructure existing configs for that to work.
This capability will be YAML-only — the legacy env-var path has no way to express it.

## Troubleshooting

**Tools not appearing.** The tool's required service block is not present in your resolved config.
Run `--list-tools` to see the live set, or call the `explain-disabled-tools` MCP tool from your client — it prints exactly which YAML block or field is missing for each disabled tool.

**`${VAR}` parse-time error.** A `${VAR}` reference resolved to no value and had no `${VAR:-default}`.
Either export the variable, pass it through `-e`, or add a default.

**Authentication errors on HTTP/SSE.** Generate a key with `--generate-key`, put it in `server.auth.api_key`, and pass it in the `cflt-mcp-api-key` header on every request.
Or run with `server.auth.disabled: true` if and only if you are on localhost-only development.
See [HTTP/SSE transport security](#httpsse-transport-security).

**`HTTP_PORT` / port conflicts.** The default is 8080.
Set `server.http.port` (YAML) or `HTTP_PORT` (env-var path) to something else.

**Tableflow authorization errors.** Tableflow tools require IAM roles in your cloud account that allow the Flink runtime to access your storage and catalog.
See the [Confluent Tableflow quick start](https://docs.confluent.io/cloud/current/topics/tableflow/get-started/quick-start-custom-storage-glue.html).
