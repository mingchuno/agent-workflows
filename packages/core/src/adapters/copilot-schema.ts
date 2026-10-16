const numericBounds = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
];
const schemaMaps = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];
const schemaArrays = ["anyOf", "oneOf", "allOf", "prefixItems"];
const schemaValues = [
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];

/** Copilot model endpoints can reject integer bounds; Zod still enforces them locally. */
export function copilotResponseSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = structuredClone(schema);
  normalizeSchema(normalized);
  return normalized;
}

function normalizeSchema(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Record<string, unknown>;
  if (
    schema.type === "integer" ||
    (Array.isArray(schema.type) && schema.type.includes("integer"))
  ) {
    for (const keyword of numericBounds) delete schema[keyword];
  }
  for (const keyword of schemaMaps) {
    const schemas = schema[keyword];
    if (schemas && typeof schemas === "object" && !Array.isArray(schemas)) {
      for (const child of Object.values(schemas)) normalizeSchema(child);
    }
  }
  for (const keyword of schemaArrays) {
    const schemas = schema[keyword];
    if (Array.isArray(schemas)) schemas.forEach(normalizeSchema);
  }
  for (const keyword of schemaValues) {
    const child = schema[keyword];
    // Older JSON Schema drafts represent tuple items as an array.
    if (keyword === "items" && Array.isArray(child))
      child.forEach(normalizeSchema);
    else normalizeSchema(child);
  }
}
