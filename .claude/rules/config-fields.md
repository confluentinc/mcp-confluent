---
paths:
  - src/config/models.ts
  - src/confluent/tools/handlers/diagnostics/describe-fields.ts
---

# Connection config fields must be classified for visibility

The `describe-configured-connection` tool surfaces a connection's config in its response card.
To guarantee no credential ever leaks and no new knob is silently ignored, every field of every connection arm and service block is classified in a visibility allow-list at `src/confluent/tools/handlers/diagnostics/describe-fields.ts`.

When you add, rename, or remove a field on any connection arm (`DirectConnectionConfig`, `OAuthConnectionConfig`) or service block (`KafkaDirectConfig`, `SchemaRegistryDirectConfig`, `ConfluentCloudDirectConfig`, `TableflowDirectConfig`, `TelemetryDirectConfig`, `FlinkDirectConfig`) — in the TypeScript interface, the Zod schema, or both — you **must** classify the field in the matching `*_FIELD_VISIBILITY` map.

This is not optional, and it is enforced two ways:

- **Compile time.** Each map is typed `Readonly<Record<keyof T, FieldVisibility>>`, so a new field fails `tsc --noEmit` (which runs in the pre-push hook and CI) with `Property '<field>' is missing` until you add a row.
- **Runtime.** `describe-fields.test.ts` asserts each map's keys equal the Zod schema's `.shape` keys, so a field added to the schema alone (not the interface) fails the drift test.

## How to classify

Pick the `FieldVisibility` that is literally true of the field:

- `public` — a non-secret scalar safe to surface (endpoint, cluster/env/org id, compute pool, region, …).
- `secret` — credential material. **All `auth` blocks are `secret`.** Never `public`.
- `withheld` — non-secret but deliberately not surfaced: a structured/opaque value (`extra_properties`), or one the card surfaces by other means (`read_only`, echoed as the top-level `readOnly` boolean).
- `block` — a nested service block, surfaced via its own map. Only valid at the connection level; a connection block classified `block` must also have an entry in `SERVICE_BLOCK_VISIBILITY`.

When in doubt between `secret` and `withheld`, ask whether the value is credential material: if it could authenticate, it is `secret`. If you classify a field `public`, confirm it is safe to hand to an LLM and surface in tool output — there is no second gate downstream.
