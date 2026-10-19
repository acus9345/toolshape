/**
 * Convert LLM tool definitions between OpenAI, Anthropic, Gemini and MCP formats.
 *
 * @example
 * import { convert } from "toolshape";
 *
 * const anthropicTool = convert(openAiTool, "anthropic");
 */
import { fromGeminiSchema, inlineRefs, toGeminiSchema, toStrictSchema, type JsonSchema } from "./schema.js";

export { fromGeminiSchema, inlineRefs, toGeminiSchema, toStrictSchema };
export type { JsonSchema };
export { convertToolCall, fromStrictArgs, isToolCall, readToolCall, readToolCalls, toolResult } from "./calls.js";
export type {
  AnthropicToolCall,
  AnthropicToolResult,
  GeminiToolCall,
  GeminiToolResult,
  MCPToolCall,
  MCPToolResult,
  OpenAIResponsesToolCall,
  OpenAIResponsesToolResult,
  OpenAIToolCall,
  OpenAIToolResult,
  ReadCallOptions,
  ToolCall,
  ToolResultOptions,
} from "./calls.js";

/**
 * - `openai`: Chat Completions, `{ type: "function", function: { name, description, parameters, strict } }`
 * - `openai-responses`: Responses API, `{ type: "function", name, description, parameters, strict }`
 * - `anthropic`: `{ name, description, input_schema }`
 * - `gemini`: a function declaration, `{ name, description, parameters }`
 * - `mcp`: an MCP tool, `{ name, title, description, inputSchema, outputSchema, annotations }`
 */
export type Format = "openai" | "openai-responses" | "anthropic" | "gemini" | "mcp";

export const FORMATS: readonly Format[] = ["openai", "openai-responses", "anthropic", "gemini", "mcp"];

/** The provider-neutral form every conversion goes through. */
export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. Always an object schema. */
  parameters: JsonSchema;
  /** OpenAI strict mode, when the source said. */
  strict?: boolean;
  /** MCP display name. */
  title?: string;
  /** MCP output schema. */
  outputSchema?: JsonSchema;
  /** MCP annotations such as `readOnlyHint`. */
  annotations?: Record<string, unknown>;
}

export interface ConvertOptions {
  /**
   * OpenAI: make the schema strict-mode compatible and set `strict: true`. `false` sets `strict: false`.
   * Default: keep the source's `strict` (Responses API tools default to `false` so loose schemas aren't rejected).
   */
  strict?: boolean;
  /** Gemini: emit `parametersJsonSchema` (full JSON Schema, no conversion) instead of `parameters`. Default `false`. */
  jsonSchema?: boolean;
  /** Gemini: write types as `"STRING"`, `"OBJECT"`... Default `false`. */
  upperCaseTypes?: boolean;
  /** Replace characters the target doesn't allow in tool names with `_` and shorten long names. Default `true`. */
  sanitizeNames?: boolean;
  /** Called with a message whenever something can't be carried over exactly. */
  onWarning?: (message: string) => void;
}

/** Thrown when a value isn't a tool definition toolshape can read. */
export class ToolShapeError extends Error {
  constructor(message: string) {
    super(`toolshape: ${message}`);
    this.name = "ToolShapeError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Guess which format a tool definition is in. Throws {@link ToolShapeError} if it isn't one. */
export function detectFormat(tool: unknown): Format {
  if (!isObject(tool)) throw new ToolShapeError(`expected a tool definition object, got ${describe(tool)}.`);
  if (tool.type === "function" && isObject(tool.function)) return "openai";
  if (tool.type === "function" && typeof tool.name === "string") return "openai-responses";
  if (Array.isArray(tool.functionDeclarations)) return "gemini";
  if (typeof tool.name === "string") {
    if ("input_schema" in tool) return "anthropic";
    if ("inputSchema" in tool) return "mcp";
    if ("parameters" in tool || "parametersJsonSchema" in tool || "description" in tool) return "gemini";
    if (tool.type === undefined) return "anthropic";
  }
  if (typeof tool.type === "string") {
    throw new ToolShapeError(
      `"${tool.type}" is a built-in tool of one provider (like web search or code execution), not a function tool, so it can't be converted.`,
    );
  }
  throw new ToolShapeError(`can't tell what format this is: ${describe(tool)}. Expected an OpenAI, Anthropic, Gemini or MCP tool.`);
}

/** Read a tool in any supported format into the neutral {@link Tool} form. */
export function toTool(tool: unknown): Tool {
  const format = detectFormat(tool);
  const t = tool as Record<string, unknown>;
  const fn = (format === "openai" ? t.function : t) as Record<string, unknown>;
  if (format === "gemini" && Array.isArray(t.functionDeclarations)) {
    throw new ToolShapeError(`this Gemini tool holds ${t.functionDeclarations.length} declarations; use convertAll() or toTools().`);
  }
  const name = fn.name;
  if (typeof name !== "string" || name === "") throw new ToolShapeError(`tool has no name: ${describe(tool)}.`);
  const rawSchema =
    format === "anthropic"
      ? t.input_schema
      : format === "mcp"
        ? t.inputSchema
        : format === "gemini"
          ? (t.parametersJsonSchema ?? t.parameters)
          : fn.parameters;
  const parameters = normalizeParameters(format === "gemini" && t.parametersJsonSchema === undefined ? fromGeminiSchema(rawSchema) : rawSchema);
  const out: Tool = { name, parameters };
  if (typeof fn.description === "string") out.description = fn.description;
  if (typeof fn.strict === "boolean") out.strict = fn.strict;
  if (format === "mcp") {
    if (typeof t.title === "string") out.title = t.title;
    if (isObject(t.outputSchema)) out.outputSchema = t.outputSchema;
    if (isObject(t.annotations)) out.annotations = t.annotations;
  }
  return out;
}

/** Read a list of tools in any mix of formats. Also accepts a Gemini tool with `functionDeclarations` or an MCP `tools/list` result. */
export function toTools(input: unknown): Tool[] {
  if (isObject(input) && Array.isArray(input.tools)) return toTools(input.tools);
  const list = Array.isArray(input) ? input : [input];
  return list.flatMap((item) =>
    isObject(item) && Array.isArray(item.functionDeclarations) ? item.functionDeclarations.map((d) => toTool(d)) : [toTool(item)],
  );
}

export type OpenAITool = {
  type: "function";
  function: { name: string; description?: string; parameters: JsonSchema; strict?: boolean };
};
export type OpenAIResponsesTool = { type: "function"; name: string; description?: string; parameters: JsonSchema; strict: boolean };
export type AnthropicTool = { name: string; description?: string; input_schema: JsonSchema };
export type GeminiFunctionDeclaration = {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  parametersJsonSchema?: JsonSchema;
};
export type MCPTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
};

/** OpenAI Chat Completions tool. */
export function toOpenAI(tool: unknown, options: ConvertOptions = {}): OpenAITool {
  return WRITERS.openai(toTool(tool), options);
}

/** OpenAI Responses API tool. */
export function toOpenAIResponses(tool: unknown, options: ConvertOptions = {}): OpenAIResponsesTool {
  return WRITERS["openai-responses"](toTool(tool), options);
}

/** Anthropic Messages API tool. */
export function toAnthropic(tool: unknown, options: ConvertOptions = {}): AnthropicTool {
  return WRITERS.anthropic(toTool(tool), options);
}

/** Gemini function declaration. Put several in `{ functionDeclarations: [...] }`, or use {@link convertAll}. */
export function toGemini(tool: unknown, options: ConvertOptions = {}): GeminiFunctionDeclaration {
  return WRITERS.gemini(toTool(tool), options);
}

/** MCP tool definition. */
export function toMCP(tool: unknown, options: ConvertOptions = {}): MCPTool {
  return WRITERS.mcp(toTool(tool), options);
}

type Converted = {
  openai: OpenAITool;
  "openai-responses": OpenAIResponsesTool;
  anthropic: AnthropicTool;
  gemini: GeminiFunctionDeclaration;
  mcp: MCPTool;
};

const WRITERS: { [F in Format]: (t: Tool, options: ConvertOptions, name?: string) => Converted[F] } = {
  openai(t, options, name) {
    const strict = options.strict ?? t.strict;
    return {
      type: "function",
      function: {
        name: name ?? targetName(t.name, "openai", options),
        ...(t.description === undefined ? {} : { description: t.description }),
        parameters: strict ? toStrictSchema(t.parameters, warner(options, t.name)) : t.parameters,
        ...(strict === undefined ? {} : { strict }),
      },
    };
  },
  "openai-responses"(t, options, name) {
    // The Responses API treats a missing `strict` as true, which rejects most hand-written schemas.
    const strict = options.strict ?? t.strict ?? false;
    return {
      type: "function",
      name: name ?? targetName(t.name, "openai-responses", options),
      ...(t.description === undefined ? {} : { description: t.description }),
      parameters: strict ? toStrictSchema(t.parameters, warner(options, t.name)) : t.parameters,
      strict,
    };
  },
  anthropic(t, options, name) {
    return {
      name: name ?? targetName(t.name, "anthropic", options),
      ...(t.description === undefined ? {} : { description: t.description }),
      input_schema: t.parameters,
    };
  },
  gemini(t, options, name) {
    const out: GeminiFunctionDeclaration = { name: name ?? targetName(t.name, "gemini", options) };
    if (t.description !== undefined) out.description = t.description;
    if (options.jsonSchema) {
      out.parametersJsonSchema = t.parameters;
    } else if (hasProperties(t.parameters)) {
      // Gemini rejects an OBJECT with empty properties, so tools without arguments omit `parameters`.
      const schemaOptions = options.upperCaseTypes === undefined ? {} : { upperCaseTypes: options.upperCaseTypes };
      out.parameters = toGeminiSchema(t.parameters, warner(options, t.name), schemaOptions);
    }
    return out;
  },
  mcp(t, options, name) {
    return {
      name: name ?? targetName(t.name, "mcp", options),
      ...(t.title === undefined ? {} : { title: t.title }),
      ...(t.description === undefined ? {} : { description: t.description }),
      inputSchema: t.parameters,
      ...(t.outputSchema === undefined ? {} : { outputSchema: t.outputSchema }),
      ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
    };
  },
};

/** Convert one tool, in any supported format, to `to`. */
export function convert<F extends Format>(tool: unknown, to: F, options: ConvertOptions = {}): Converted[F] {
  return writer(to)(toTool(tool), options);
}

function writer<F extends Format>(to: F): (t: Tool, options: ConvertOptions, name?: string) => Converted[F] {
  const w = WRITERS[to];
  if (!w) throw new ToolShapeError(`unknown target format "${String(to)}". Use one of: ${FORMATS.join(", ")}.`);
  return w;
}

export interface ConvertAllResult<F extends Format> {
  /** Converted tools. For Gemini this is `[{ functionDeclarations: [...] }]`, ready for `config.tools`. */
  tools: F extends "gemini" ? [{ functionDeclarations: GeminiFunctionDeclaration[] }] : Converted[F][];
  /** Everything that couldn't be carried over exactly. */
  warnings: string[];
  /** New name → original name, for tools that had to be renamed. Use it to map tool calls back. */
  renamed: Record<string, string>;
}

/**
 * Convert a list of tools (or a Gemini tool, or an MCP `tools/list` result) to `to`.
 * Collects warnings, and keeps renamed tools unique.
 */
export function convertAll<F extends Format>(input: unknown, to: F, options: ConvertOptions = {}): ConvertAllResult<F> {
  const warnings: string[] = [];
  const renamed: Record<string, string> = {};
  const used = new Set<string>();
  const opts: ConvertOptions = {
    ...options,
    onWarning: (m) => {
      warnings.push(m);
      options.onWarning?.(m);
    },
  };
  const write = writer(to);
  const converted = toTools(input).map((tool) => {
    let name = targetName(tool.name, to, opts);
    if (used.has(name)) {
      const base = name.slice(0, NAME_RULES[to].max - 3);
      let n = 2;
      while (used.has(`${base}_${n}`)) n++;
      name = `${base}_${n}`;
      opts.onWarning!(`tool "${tool.name}" was renamed to "${name}" to keep names unique.`);
    }
    used.add(name);
    if (name !== tool.name) renamed[name] = tool.name;
    return write(tool, opts, name);
  });
  const tools = (to === "gemini" ? [{ functionDeclarations: converted }] : converted) as ConvertAllResult<F>["tools"];
  return { tools, warnings, renamed };
}

// --- helpers -----------------------------------------------------------------

const NAME_RULES: Record<Format, { pattern: RegExp; bad: RegExp; max: number; first?: RegExp }> = {
  openai: { pattern: /^[a-zA-Z0-9_-]+$/, bad: /[^a-zA-Z0-9_-]/g, max: 64 },
  "openai-responses": { pattern: /^[a-zA-Z0-9_-]+$/, bad: /[^a-zA-Z0-9_-]/g, max: 64 },
  anthropic: { pattern: /^[a-zA-Z0-9_-]+$/, bad: /[^a-zA-Z0-9_-]/g, max: 128 },
  gemini: { pattern: /^[a-zA-Z_][a-zA-Z0-9_.:-]*$/, bad: /[^a-zA-Z0-9_.:-]/g, max: 64, first: /^[a-zA-Z_]/ },
  mcp: { pattern: /^[a-zA-Z0-9_.-]+$/, bad: /[^a-zA-Z0-9_.-]/g, max: 128 },
};

function targetName(name: string, to: Format, options: ConvertOptions): string {
  const rule = NAME_RULES[to];
  if (rule.pattern.test(name) && name.length <= rule.max) return name;
  if (options.sanitizeNames === false) {
    options.onWarning?.(`tool name "${name}" is not valid for ${to} (allowed: ${rule.pattern.source}, up to ${rule.max} characters).`);
    return name;
  }
  let fixed = name.replace(rule.bad, "_");
  if (rule.first && !rule.first.test(fixed)) fixed = `_${fixed}`;
  if (fixed.length > rule.max) fixed = fixed.slice(0, rule.max);
  options.onWarning?.(`tool "${name}" was renamed to "${fixed}" because ${to} doesn't allow that name.`);
  return fixed;
}

function normalizeParameters(schema: unknown): JsonSchema {
  if (schema === undefined || schema === null) return { type: "object", properties: {} };
  if (!isObject(schema)) throw new ToolShapeError(`parameters must be a JSON Schema object, got ${describe(schema)}.`);
  if (schema.type === undefined && isObject(schema.properties)) return { type: "object", ...schema };
  if (schema.type !== "object") {
    throw new ToolShapeError(`tool parameters must be an object schema (type: "object"), got type ${JSON.stringify(schema.type)}.`);
  }
  return schema;
}

function hasProperties(schema: JsonSchema): boolean {
  return isObject(schema.properties) && Object.keys(schema.properties).length > 0;
}

function warner(options: ConvertOptions, toolName: string): (m: string) => void {
  return (m) => options.onWarning?.(`${toolName}: ${m}`);
}

function describe(v: unknown): string {
  const text = JSON.stringify(v);
  return text === undefined ? String(v) : text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
