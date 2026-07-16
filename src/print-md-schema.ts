/**
 * @fileoverview Utility script to generate markdown documentation for environment variables.
 * This script is only used to generate markdown content for the README file and is not used by the server.
 * It converts Zod schema definitions into a formatted markdown table.
 */

import { combinedSchema } from "@src/env-schema.js";
import { z } from "zod";

function zodSchemaToMarkdown(schema: z.ZodTypeAny, parentKey = ""): string {
  // Initialize table header
  if (!parentKey) {
    return (
      "| Variable | Description | Default Value | Required |\n" +
      "|----------|-------------|---------------|----------|\n" +
      extractRows(schema)
    );
  }
  return extractRows(schema);
}

function extractRows(schema: z.ZodTypeAny, parentKey = ""): string {
  // Handle objects (nested properties)
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape)
      .map(([key, subSchema]) => {
        const fullKey = parentKey ? `${parentKey}.${key}` : key;
        const isRequired = !(subSchema instanceof z.ZodOptional);
        return {
          key: fullKey,
          schema:
            subSchema instanceof z.ZodObject
              ? subSchema
              : (subSchema as z.ZodTypeAny),
          isRequired,
        };
      })
      .sort((a, b) => {
        // Sort by required status first (required comes first)
        if (a.isRequired !== b.isRequired) {
          return a.isRequired ? -1 : 1;
        }
        // Then sort alphabetically
        return a.key.localeCompare(b.key);
      })
      .map(({ key, schema }) => {
        if (schema instanceof z.ZodObject) {
          return extractRows(schema, key);
        }
        return formatTableRow(key, schema);
      })
      .join("");
  }

  // Handle non-object schemas
  return formatTableRow(parentKey, schema);
}

function formatTableRow(key: string, schema: z.ZodTypeAny): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let description = (schema as any).description || "";
  let defaultValue = "";
  const isRequired = !(schema instanceof z.ZodOptional);

  // Extract default value if exists
  if (schema instanceof z.ZodDefault) {
    defaultValue = JSON.stringify(schema.def.defaultValue);
    schema = schema.unwrap() as z.ZodTypeAny;
  }

  // Add type information to description if not empty
  const typeInfo = getTypeInfo(schema);
  description = description ? `${description} (${typeInfo})` : typeInfo;

  // Format the table row
  return `| ${key} | ${description} | ${defaultValue} | ${isRequired ? "Yes" : "No"} |\n`;
}

function getTypeInfo(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString)
    return describeBounded("string", schema.minLength, schema.maxLength);
  if (schema instanceof z.ZodNumber)
    return describeBounded("number", schema.minValue, schema.maxValue);
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return `enum: ${schema.options.join(" | ")}`;
  if (schema instanceof z.ZodArray)
    return `array of ${getTypeInfo(schema.element as z.ZodTypeAny)}`;
  if (schema instanceof z.ZodOptional)
    return `${getTypeInfo(schema.unwrap() as z.ZodTypeAny)}`;
  if (schema instanceof z.ZodNullable)
    return `nullable ${getTypeInfo(schema.unwrap() as z.ZodTypeAny)}`;
  if (schema instanceof z.ZodUnion)
    return `union: ${schema.options.map((opt) => getTypeInfo(opt as z.ZodTypeAny)).join(" | ")}`;
  return schema.constructor.name.replace("Zod", "").toLowerCase();
}

/**
 * Render a scalar type label with any min/max bounds appended as
 * `label (min: X, max: Y)`, omitting absent bounds and the parenthetical
 * entirely when neither is present. Shared by the string- and number-length
 * arms of getTypeInfo, whose only difference is the label and which pair of
 * bound accessors they read.
 */
function describeBounded(
  label: string,
  min: number | null,
  max: number | null,
): string {
  const constraints = [
    min !== null && `min: ${min}`,
    max !== null && `max: ${max}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `${label}${constraints ? ` (${constraints})` : ""}`;
}

// Generate markdown table from schema and print to console
console.log(zodSchemaToMarkdown(combinedSchema));
