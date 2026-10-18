/** A JSON Schema object. Kept loose on purpose: tool schemas come from everywhere. */
export type JsonSchema = { [key: string]: unknown };

type Warn = (message: string) => void;

const isObject = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

const NUMERIC_KEYS = ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties", "minimum", "maximum"];

/**
 * Read a schema written in Gemini's OpenAPI subset (uppercase types, `nullable`, numbers as strings)
 * or plain JSON Schema, and return plain JSON Schema.
 */
export function fromGeminiSchema(schema: unknown): JsonSchema {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!isObject(s)) return s;
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
      else if (k === "type" && Array.isArray(v)) out.type = v.map((t) => (typeof t === "string" ? t.toLowerCase() : t));
      else if (k === "properties" && isObject(v)) out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, walk(ps)]));
      else if (NUMERIC_KEYS.includes(k) && typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
      else if (k === "propertyOrdering" || k === "nullable") continue;
      else out[k] = walk(v);
    }
    if (s.nullable === true) {
      if (typeof out.type === "string") out.type = [out.type, "null"];
      else if (Array.isArray(out.anyOf)) out.anyOf = [...out.anyOf, { type: "null" }];
    }
    if (out.format === "enum") delete out.format;
    return out;
  };
  return walk(clone(schema)) as JsonSchema;
}

/** Replace every `$ref` with the definition it points to. Recursive references stop after one level. */
export function inlineRefs(schema: JsonSchema, warn: Warn): JsonSchema {
  const root = schema;
  const resolve = (ref: string): unknown => {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      node = isObject(node) ? node[key] : undefined;
    }
    return node;
  };
  const walk = (s: unknown, stack: readonly string[]): unknown => {
    if (Array.isArray(s)) return s.map((x) => walk(x, stack));
    if (!isObject(s)) return s;
    if (typeof s.$ref === "string") {
      const ref = s.$ref;
      const target = resolve(ref);
      if (target === undefined) {
        warn(`could not resolve $ref "${ref}"; replaced it with an empty schema.`);
        return {};
      }
      if (stack.includes(ref)) {
        warn(`recursive $ref "${ref}" can't be inlined; the nested copy was replaced with { type: "object" }.`);
        return { type: "object", ...(typeof s.description === "string" ? { description: s.description } : {}) };
      }
      const { $ref: _, ...siblings } = s;
      return walk({ ...(target as JsonSchema), ...siblings }, [...stack, ref]);
    }
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "$defs" || k === "definitions") continue;
      out[k] = k === "properties" && isObject(v) ? Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, walk(ps, stack)])) : walk(v, stack);
    }
    return out;
  };
  return walk(schema, []) as JsonSchema;
}

const GEMINI_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);
const SILENT_DROP = new Set(["$schema", "$id", "$comment", "additionalProperties", "examples", "readOnly", "writeOnly", "deprecated"]);
const GEMINI_FORMATS: Record<string, readonly string[]> = {
  string: ["enum", "date-time"],
  number: ["float", "double"],
  integer: ["int32", "int64"],
};

export interface GeminiSchemaOptions {
  /** Write types as `"STRING"`, `"OBJECT"`... like the Google SDK's `Type` enum. Default `false`. */
  upperCaseTypes?: boolean;
}

/** Convert JSON Schema to the OpenAPI 3.0 subset Gemini's `parameters` field accepts. */
export function toGeminiSchema(schema: JsonSchema, warn: Warn, options: GeminiSchemaOptions = {}): JsonSchema {
  const inlined = inlineRefs(clone(schema), warn);
  const typeName = (t: string) => (options.upperCaseTypes ? t.toUpperCase() : t);
  const dropped = new Set<string>();

  const walk = (s: unknown, path: string): JsonSchema => {
    if (!isObject(s)) return {};
    let src: JsonSchema = { ...s };

    if (Array.isArray(src.allOf)) {
      const parts = src.allOf.filter(isObject);
      if (parts.every((p) => p.type === undefined || p.type === "object")) {
        const merged: JsonSchema = { type: "object", properties: {}, required: [] };
        for (const p of parts) {
          Object.assign(merged.properties as JsonSchema, p.properties ?? {});
          (merged.required as string[]).push(...((p.required as string[] | undefined) ?? []));
        }
        const { allOf: _, ...rest } = src;
        src = {
          ...merged,
          ...rest,
          properties: { ...(merged.properties as JsonSchema), ...((rest.properties as JsonSchema | undefined) ?? {}) },
          required: [...new Set([...(merged.required as string[]), ...((rest.required as string[] | undefined) ?? [])])],
        };
      } else {
        warn(`${path}: allOf with non-object parts isn't supported by Gemini; only the first part was kept.`);
        const { allOf: _, ...rest } = src;
        src = { ...(parts[0] ?? {}), ...rest };
      }
    }
    if (Array.isArray(src.oneOf)) {
      src.anyOf = [...((src.anyOf as unknown[] | undefined) ?? []), ...src.oneOf];
      delete src.oneOf;
      warn(`${path}: oneOf became anyOf (Gemini has no oneOf), so "exactly one" is no longer enforced.`);
    }
    if ("const" in src) {
      if (typeof src.const === "string") src.enum = [src.const];
      else warn(`${path}: const ${JSON.stringify(src.const)} dropped (Gemini only supports string enums).`);
      delete src.const;
    }
    if (src.examples !== undefined && src.example === undefined && Array.isArray(src.examples)) src.example = src.examples[0];

    const out: JsonSchema = {};
    let type = src.type;
    let nullable = src.nullable === true;
    if (Array.isArray(type)) {
      const types = type.filter((t) => t !== "null");
      nullable ||= types.length < type.length;
      if (types.length === 1) type = types[0];
      else if (types.length > 1) {
        type = undefined;
        out.anyOf = types.map((t) => ({ type: typeName(String(t)) }));
      } else type = undefined;
    }
    if (type === "null") {
      nullable = true;
      type = undefined;
    }

    for (const [k, v] of Object.entries(src)) {
      if (k === "type" || k === "nullable") continue;
      if (k === "properties" && isObject(v)) {
        out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, walk(ps, `${path}.${p}`)]));
      } else if (k === "items") {
        out.items = Array.isArray(v) ? walk(v[0], `${path}[]`) : walk(v, `${path}[]`);
        if (Array.isArray(v)) warn(`${path}: tuple "items" became a single item schema.`);
      } else if (k === "anyOf" && Array.isArray(v)) {
        const options = v.filter((x) => !(isObject(x) && x.type === "null"));
        if (options.length < v.length) nullable = true;
        if (options.length === 1) Object.assign(out, walk(options[0], path));
        else out.anyOf = options.map((x, i) => walk(x, `${path}|${i}`));
      } else if (k === "enum" && Array.isArray(v)) {
        const strings = v.filter((x) => x !== null);
        if (v.includes(null)) nullable = true;
        if (strings.every((x) => typeof x === "string")) {
          out.enum = strings;
          if (type === undefined) type = "string";
          if (type === "string") out.format = "enum";
        } else {
          warn(`${path}: non-string enum ${JSON.stringify(v)} dropped (Gemini only supports string enums).`);
        }
      } else if (k === "format" && typeof v === "string") {
        const allowed = GEMINI_FORMATS[String(type)] ?? [];
        if (allowed.includes(v)) out.format = v;
        else warn(`${path}: format "${v}" dropped (Gemini supports ${allowed.length ? allowed.join(", ") : "no formats"} for ${String(type)}).`);
      } else if (k === "exclusiveMinimum" || k === "exclusiveMaximum") {
        if (typeof v === "number") out[k === "exclusiveMinimum" ? "minimum" : "maximum"] = v;
        warn(`${path}: ${k} became an inclusive bound.`);
      } else if (GEMINI_KEYS.has(k)) {
        if (!(k in out)) out[k] = v;
      } else if (!SILENT_DROP.has(k)) {
        dropped.add(k);
      } else if (k === "additionalProperties" && isObject(v)) {
        warn(`${path}: additionalProperties with a schema (a free-form map) can't be expressed for Gemini and was dropped.`);
      }
    }
    if (nullable) out.nullable = true;
    if (type !== undefined) {
      // Put `type` first so converted schemas read naturally.
      const rest = { ...out };
      for (const k of Object.keys(out)) delete out[k];
      Object.assign(out, { type: typeName(String(type)) }, rest);
    }
    if (type === "object" && !isObject(out.properties) && out.anyOf === undefined) {
      warn(`${path}: an object without "properties" may be rejected by Gemini. Describe its fields, or use { jsonSchema: true }.`);
    }
    if (Array.isArray(out.required) && isObject(out.properties)) {
      const props = out.properties;
      out.required = (out.required as string[]).filter((r) => r in props);
      if ((out.required as string[]).length === 0) delete out.required;
    }
    return out;
  };

  const result = walk(inlined, "parameters");
  if (dropped.size > 0) warn(`dropped keywords Gemini doesn't support: ${[...dropped].sort().join(", ")}.`);
  return result;
}

/**
 * Make a schema valid for OpenAI strict mode: every object gets `additionalProperties: false`
 * and lists all its properties as required; properties that were optional become nullable.
 */
export function toStrictSchema(schema: JsonSchema, warn: Warn): JsonSchema {
  const walk = (s: unknown, path: string): unknown => {
    if (Array.isArray(s)) return s.map((x) => walk(x, path));
    if (!isObject(s)) return s;
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && isObject(v)) {
        out.properties = Object.fromEntries(Object.entries(v).map(([p, ps]) => [p, walk(ps, `${path}.${p}`)]));
      } else if (k === "$defs" || k === "definitions") {
        out[k] = isObject(v) ? Object.fromEntries(Object.entries(v).map(([d, ds]) => [d, walk(ds, `#/${k}/${d}`)])) : v;
      } else if (k === "items" || k === "anyOf" || k === "oneOf" || k === "allOf" || k === "not" || k === "prefixItems") {
        out[k] = walk(v, `${path}[]`);
      } else out[k] = v;
    }
    const isObj = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || isObject(out.properties);
    if (isObj) {
      const props = isObject(out.properties) ? out.properties : {};
      out.properties = props;
      if (isObject(out.additionalProperties)) {
        warn(`${path}: additionalProperties with a schema isn't allowed in strict mode; set to false.`);
      }
      out.additionalProperties = false;
      const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
      for (const [name, prop] of Object.entries(props)) {
        if (!required.has(name)) props[name] = makeNullable(prop);
      }
      out.required = Object.keys(props);
    }
    if (Array.isArray(out.oneOf)) {
      out.anyOf = [...((out.anyOf as unknown[] | undefined) ?? []), ...out.oneOf];
      delete out.oneOf;
      warn(`${path}: oneOf became anyOf (strict mode doesn't support oneOf).`);
    }
    return out;
  };
  return walk(clone(schema), "parameters") as JsonSchema;
}

function makeNullable(prop: unknown): unknown {
  if (!isObject(prop)) return prop;
  if (typeof prop.type === "string") {
    const out: JsonSchema = { ...prop, type: prop.type === "null" ? "null" : [prop.type, "null"] };
    if (Array.isArray(prop.enum) && !prop.enum.includes(null)) out.enum = [...prop.enum, null];
    return out;
  }
  if (Array.isArray(prop.type)) {
    return prop.type.includes("null") ? prop : { ...prop, type: [...prop.type, "null"] };
  }
  if (Array.isArray(prop.anyOf)) {
    return prop.anyOf.some((x) => isObject(x) && x.type === "null") ? prop : { ...prop, anyOf: [...prop.anyOf, { type: "null" }] };
  }
  return { anyOf: [prop, { type: "null" }] };
}
