# mcp-confluent

## Getting Started

### Create your own .env file

```bash
BOOTSTRAP_SERVERS="pkc-v12gj.northamerica-northeast2.gcp.confluent.cloud:9092"
KAFKA_API_KEY="..."
KAFKA_API_SECRET="..."
FLINK_ENV_ID="env-..."
FLINK_ORG_ID=""
FLINK_REST_ENDPOINT="https://flink.us-east4.gcp.confluent.cloud"
FLINK_ENV_NAME=""
FLINK_DATABASE_NAME=""
FLINK_API_KEY=""
FLINK_API_SECRET=""
FLINK_COMPUTE_POOL_ID="lfcp-..."
CONFLUENT_CLOUD_API_KEY=""
CONFLUENT_CLOUD_API_SECRET=""
KAFKA_CLUSTER_ID=""
KAFKA_ENV_ID="env-..."
CONFLUENT_CLOUD_REST_ENDPOINT="https://api.confluent.cloud"
```

### Incremental watch mode of typescript

Running the following command will watch for changes in the typescript files and compile them to javascript.

```bash
npm run dev
```

If you wish to only build the typescript files once, you can run the following command.

```bash
npm run build
```

### Run your server

```bash
npm run start
```

### Testing your mcp server

For testing MCP servers, you can use [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) which is an interactive developer tool for testing and debugging MCP servers.

```bash
# make sure you've already built the project either in dev mode or by running npm run build
npx @modelcontextprotocol/inspector node --env-file $PATH_TO_PROJECT/.env /$PATH_TO_PROJECT/dist/index.js
```

### Generating confluent cloud typescript types from openapi schema

If you need to regenerate the typescript types from the openapi schema, you can run the following command.

```bash
# as of v7.5.2 there is a bug when using allOf w/ required https://github.com/openapi-ts/openapi-typescript/issues/1474. need --empty-objects-unknown flag to avoid it
npx openapi-typescript ./openapi.json -o ./src/confluent/openapi-schema.d.ts --empty-objects-unknown
```

## Adding a new Tool

To add a new tool, you can follow these steps:

1. Add a new enum to the enum class `ToolName`
2. Add your new to the handlers map in the `ToolFactory` class.
3. Create a new file, exporting the class that extends `BaseToolHandler`.
   1. Implement the `handle` method of the base class.
   2. Implement the `getToolConfig` method of the base class.
4. Once satisfied, add it to the set of `enabledTools` in `index.ts`.