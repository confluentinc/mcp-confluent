import { z } from "zod";
import { combinedSchema } from "./env-schema.js";

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
    defaultValue = JSON.stringify(schema._def.defaultValue());
    schema = schema.removeDefault();
  }

  // Add type information to description if not empty
  const typeInfo = getTypeInfo(schema);
  description = description ? `${description} (${typeInfo})` : typeInfo;

  // Format the table row
  return `| ${key} | ${description} | ${defaultValue} | ${isRequired ? "Yes" : "No"} |\n`;
}

function getTypeInfo(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) {
    const constraints = [
      schema.minLength !== null && `min: ${schema.minLength}`,
      schema.maxLength !== null && `max: ${schema.maxLength}`,
    ]
      .filter(Boolean)
      .join(", ");
    return `string${constraints ? ` (${constraints})` : ""}`;
  }
  if (schema instanceof z.ZodNumber) {
    const constraints = [
      schema.minValue !== null && `min: ${schema.minValue}`,
      schema.maxValue !== null && `max: ${schema.maxValue}`,
    ]
      .filter(Boolean)
      .join(", ");
    return `number${constraints ? ` (${constraints})` : ""}`;
  }
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return `enum: ${schema.options.join(" | ")}`;
  if (schema instanceof z.ZodArray)
    return `array of ${getTypeInfo(schema.element)}`;
  if (schema instanceof z.ZodOptional) return `${getTypeInfo(schema.unwrap())}`;
  if (schema instanceof z.ZodNullable)
    return `nullable ${getTypeInfo(schema.unwrap())}`;
  if (schema instanceof z.ZodUnion)
    return `union: ${schema.options.map((opt) => getTypeInfo(opt)).join(" | ")}`;
  return schema.constructor.name.replace("Zod", "").toLowerCase();
}

// Generate and export the markdown documentation
const markdownDocs = zodSchemaToMarkdown(combinedSchema);
console.log(markdownDocs); // For debugging
export { markdownDocs };
