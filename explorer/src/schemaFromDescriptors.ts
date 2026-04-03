/**
 * Pure utilities for converting between ValueDescriptor-based field schemas,
 * JSON Schema (for Monaco YAML validation), and YAML values.
 *
 * No React or Monaco dependencies -- safe for use in the explorer package.
 */

// Note: uses relative import so this works in both Deno (tests) and npm (explorer build) contexts.
import type { FieldRequest } from "../../src/core/DefaultBuilderHost.ts";

// -- Types ----------------------------------------------------------------

// deno-lint-ignore no-explicit-any
type JsonSchema = Record<string, any>;

// -- descriptorToJsonSchema -----------------------------------------------

/**
 * Convert an array of FieldRequests (from DefaultBuilderHost.getFields())
 * into a JSON Schema object suitable for monaco-yaml.
 *
 * Bytes fields become hex strings with 0x prefix pattern.
 * Nested fields (from beginObject/endObject) become nested properties.
 */
export function descriptorToJsonSchema(fields: FieldRequest[]): JsonSchema {
  const root: JsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };

  for (const field of fields) {
    if (field.kind === "arrayLength") continue;

    const fieldSchema = fieldToSchema(field);
    placeAtPath(root, field.path, fieldSchema);
  }

  return root;
}

function fieldToSchema(field: FieldRequest): JsonSchema {
  const schema: JsonSchema = {};
  const desc = field.desc;

  switch (field.kind) {
    case "bytes":
      schema.type = "string";
      schema.pattern = "^(0x([0-9a-fA-F]{2})*)?$";
      break;
    case "string":
      schema.type = "string";
      break;
    case "number":
      schema.type = "number";
      break;
    case "bool":
      schema.type = "boolean";
      break;
  }

  if (desc.options && desc.options.length > 0) {
    schema.enum = desc.options.map((o) => o.value);
    const enumDescs = desc.options.map((o) =>
      o.markdownDescription ?? o.shortDescription
    );
    if (enumDescs.some((d) => d)) {
      schema.markdownEnumDescriptions = enumDescs;
    }
  }

  schema.description = desc.shortDescription;
  if (desc.markdownDescription) {
    schema.markdownDescription = desc.markdownDescription;
  }
  if (desc.type) {
    const typeHint = `Type: \`${desc.type}\``;
    schema.markdownDescription = schema.markdownDescription
      ? `${schema.markdownDescription}\n\n${typeHint}`
      : typeHint;
  }

  return schema;
}

function placeAtPath(
  root: JsonSchema,
  path: string[],
  fieldSchema: JsonSchema,
): void {
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (!current.properties) current.properties = {};
    if (!current.properties[segment]) {
      current.properties[segment] = {
        type: "object",
        additionalProperties: false,
        properties: {},
      };
    }
    current = current.properties[segment];
  }

  const key = path[path.length - 1];
  if (!current.properties) current.properties = {};
  current.properties[key] = fieldSchema;
}

// -- fieldsToDefaultYaml --------------------------------------------------

/**
 * Generate a default YAML-compatible object from field requests.
 * Returns a plain object that can be passed to yaml.stringify().
 */
export function fieldsToDefaultObject(
  fields: FieldRequest[],
  // deno-lint-ignore no-explicit-any
): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  const root: Record<string, any> = {};

  for (const field of fields) {
    if (field.kind === "arrayLength") continue;
    const value = defaultValueForField(field);
    setNestedValue(root, field.path, value);
  }

  return root;
}

function defaultValueForField(field: FieldRequest): unknown {
  const desc = field.desc;

  // If enum options exist, use first option value
  if (desc.options && desc.options.length > 0) {
    return desc.options[0].value;
  }

  switch (field.kind) {
    case "bytes":
      return "0x";
    case "string":
      return "";
    case "number":
      return 0;
    case "bool":
      return false;
    default:
      return null;
  }
}

function setNestedValue(
  // deno-lint-ignore no-explicit-any
  obj: Record<string, any>,
  path: string[],
  value: unknown,
): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key];
  }
  current[path[path.length - 1]] = value;
}

// -- yamlToBuilderValues --------------------------------------------------

/**
 * Convert a parsed YAML object back into the Map<string, unknown> that
 * DefaultBuilderHost expects. Keys are dot-joined paths.
 *
 * Hex strings (0x...) for bytes fields are converted to Uint8Array.
 * All other values are passed through as-is.
 */
export function yamlToBuilderValues(
  // deno-lint-ignore no-explicit-any
  yamlObj: Record<string, any>,
  fields: FieldRequest[],
): Map<string, unknown> {
  const values = new Map<string, unknown>();

  for (const field of fields) {
    if (field.kind === "arrayLength") continue;

    const pathKey = field.path.join(".");
    const rawValue = getNestedValue(yamlObj, field.path);
    if (rawValue === undefined) continue;

    if (field.kind === "bytes") {
      values.set(pathKey, hexToBytes(rawValue as string));
    } else {
      values.set(pathKey, rawValue);
    }
  }

  return values;
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex || hex === "0x") return new Uint8Array(0);
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// deno-lint-ignore no-explicit-any
function getNestedValue(obj: Record<string, any>, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
