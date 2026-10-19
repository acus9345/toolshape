/**
 * Tool calls and tool results: reading the calls a model makes in any provider's format, writing them
 * in another (to replay a conversation), and wrapping your tool's result the way each provider wants it.
 */
import { FORMATS, toTools, ToolShapeError, type Format } from "./index.js";
import { inlineRefs, type JsonSchema } from "./schema.js";

/** A tool call in neutral form. */
export interface ToolCall {
  /** The call id (`call_id` / `tool_use_id`). Gemini and MCP calls often have none. */
  id?: string;
  name: string;
  /** Parsed arguments. */
  arguments: Record<string, unknown>;
}

export interface ReadCallOptions {
  /** New name → original name, as returned by `convertAll()`. Calls to renamed tools get their original name back. */
  renamed?: Record<string, string>;
  /**
   * The original tool definitions, in any format. When given, `null`s that OpenAI strict mode forced into optional
   * arguments are removed again (see `fromStrictArgs()`), so the tool sees the arguments its own schema expects.
   */
  tools?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a value looks like a tool call in any supported format. */
export function isToolCall(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "function" && isObject(value.function)) return true;
  if (value.type === "function_call" || value.type === "tool_use") return true;
  if (isObject(value.functionCall)) return true;
  if (value.method === "tools/call" && isObject(value.params)) return true;
  return typeof value.name === "string" && ("args" in value || "input" in value || "arguments" in value) && value.type === undefined;
}

/** Read one tool call in any format into the neutral {@link ToolCall} form. */
export function readToolCall(call: unknown, options: ReadCallOptions = {}): ToolCall {
  return finish(parseCall(call), options, schemasFor(options));
}

/**
 * Read every tool call in a model response: an OpenAI chat completion or assistant message, a Responses API
 * response or its `output`, an Anthropic message or its `content`, a Gemini response, candidate content or parts,
 * or a list of calls. Anything that isn't a tool call (text, reasoning) is skipped.
 */
export function readToolCalls(response: unknown, options: ReadCallOptions = {}): ToolCall[] {
  const schemas = schemasFor(options);
  return collectCalls(response).map((c) => finish(parseCall(c), options, schemas));
}

function collectCalls(r: unknown): unknown[] {
  if (Array.isArray(r)) return r.flatMap((x) => (isToolCall(x) ? [x] : isObject(x) && Array.isArray(x.parts) ? collectCalls(x) : []));
  if (!isObject(r)) throw new ToolShapeError(`expected a model response or a tool call, got ${describe(r)}.`);
  if (Array.isArray(r.choices)) {
    const message = isObject(r.choices[0]) ? r.choices[0].message : undefined;
    return isObject(message) && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  }
  if (Array.isArray(r.tool_calls)) return r.tool_calls;
  if (Array.isArray(r.output)) return r.output.filter(isToolCall);
  if (Array.isArray(r.candidates)) {
    const content = isObject(r.candidates[0]) ? r.candidates[0].content : undefined;
    return isObject(content) && Array.isArray(content.parts) ? content.parts.filter(isToolCall) : [];
  }
  if (Array.isArray(r.parts)) return r.parts.filter(isToolCall);
  if (Array.isArray(r.content)) return r.content.filter(isToolCall);
  if (isToolCall(r)) return [r];
  if (r.role !== undefined || r.type === "message") return [];
  throw new ToolShapeError(`can't find tool calls in ${describe(r)}.`);
}

function parseCall(call: unknown): ToolCall {
  if (!isToolCall(call)) {
    throw new ToolShapeError(`expected a tool call (OpenAI, Responses, Anthropic, Gemini or MCP), got ${describe(call)}.`);
  }
  const c = call as Record<string, unknown>;
  if (c.type === "function" && isObject(c.function)) return make(c.id, c.function.name, c.function.arguments);
  if (c.type === "function_call") return make(c.call_id ?? c.id, c.name, c.arguments);
  if (c.type === "tool_use") return make(c.id, c.name, c.input);
  if (isObject(c.functionCall)) return make(c.functionCall.id, c.functionCall.name, c.functionCall.args);
  if (c.method === "tools/call" && isObject(c.params)) return make(c.id, c.params.name, c.params.arguments);
  return make(c.id, c.name, c.args ?? c.input ?? c.arguments);
}

function make(id: unknown, name: unknown, args: unknown): ToolCall {
  if (typeof name !== "string" || name === "") throw new ToolShapeError(`tool call has no name.`);
  let parsed = args;
  if (typeof args === "string") {
    try {
      parsed = args.trim() === "" ? {} : JSON.parse(args);
    } catch {
      throw new ToolShapeError(`arguments of the call to "${name}" aren't valid JSON: ${describe(args)}.`);
    }
  }
  parsed ??= {};
  if (!isObject(parsed)) throw new ToolShapeError(`arguments of the call to "${name}" must be an object, got ${describe(parsed)}.`);
  return { ...(typeof id === "string" || typeof id === "number" ? { id: String(id) } : {}), name, arguments: parsed };
}

function schemasFor(options: ReadCallOptions): Map<string, JsonSchema> | undefined {
  if (options.tools === undefined) return undefined;
  return new Map(toTools(options.tools).map((t) => [t.name, t.parameters]));
}

function finish(call: ToolCall, options: ReadCallOptions, schemas: Map<string, JsonSchema> | undefined): ToolCall {
  const name = options.renamed?.[call.name] ?? call.name;
  const schema = schemas?.get(name);
  return { ...call, name, arguments: schema ? fromStrictArgs(call.arguments, schema) : call.arguments };
}

/**
 * Undo what OpenAI strict mode does to optional arguments: strict schemas make every property required and
 * optional ones nullable, so the model sends `null` for arguments it means to leave out. Given the tool's
 * original schema, this removes those `null`s again, at every depth. A `null` the original schema allows stays.
 */
export function fromStrictArgs(args: Record<string, unknown>, originalSchema: JsonSchema): Record<string, unknown> {
  const schema = inlineRefs(originalSchema, () => {});
  return walk(args, schema) as Record<string, unknown>;
}

function walk(value: unknown, schema: unknown): unknown {
  if (!isObject(schema)) return value;
  if (Array.isArray(value)) {
    const items = Array.isArray(schema.items) ? undefined : schema.items;
    return items === undefined ? value : value.map((v) => walk(v, items));
  }
  if (!isObject(value)) return value;
  const branch = objectBranch(schema);
  if (!branch) return value;
  const props = isObject(branch.properties) ? branch.properties : {};
  const required = new Set(Array.isArray(branch.required) ? (branch.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null && !required.has(key) && key in props && !allowsNull(props[key])) continue;
    out[key] = walk(v, props[key]);
  }
  return out;
}

/** The part of a schema that describes an object: itself, or the first object-like `anyOf`/`oneOf`/`allOf` branch. */
function objectBranch(schema: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isObject(schema.properties)) return schema;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const list = schema[key];
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (isObject(s)) {
        const found = objectBranch(s);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function allowsNull(schema: unknown): boolean {
  if (!isObject(schema)) return true;
  if (schema.type === "null" || schema.nullable === true || schema.const === null) return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true;
  for (const key of ["anyOf", "oneOf"]) {
    const list = schema[key];
    if (Array.isArray(list) && list.some(allowsNull)) return true;
  }
  // No type at all means anything goes, null included.
  return schema.type === undefined && schema.enum === undefined && schema.const === undefined && !isObject(schema.properties) &&
    schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined;
}

// --- writing -------------------------------------------------------------------

export type OpenAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type OpenAIResponsesToolCall = { type: "function_call"; call_id: string; name: string; arguments: string };
export type AnthropicToolCall = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type GeminiToolCall = { functionCall: { id?: string; name: string; args: Record<string, unknown> } };
export type MCPToolCall = { name: string; arguments: Record<string, unknown> };

type ConvertedCall = {
  openai: OpenAIToolCall;
  "openai-responses": OpenAIResponsesToolCall;
  anthropic: AnthropicToolCall;
  gemini: GeminiToolCall;
  mcp: MCPToolCall;
};

/**
 * Write a tool call (in any format) in the `to` format, for replaying a conversation to another provider.
 * OpenAI and Anthropic need an id; one is generated when the call has none. MCP gets `tools/call` params.
 */
export function convertToolCall<F extends Format>(call: unknown, to: F): ConvertedCall[F] {
  const c = readToolCall(call);
  const id = c.id ?? generatedId(to);
  const written: { [K in Format]: () => ConvertedCall[K] } = {
    openai: () => ({ id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }),
    "openai-responses": () => ({ type: "function_call", call_id: id, name: c.name, arguments: JSON.stringify(c.arguments) }),
    anthropic: () => ({ type: "tool_use", id, name: c.name, input: c.arguments }),
    gemini: () => ({ functionCall: { ...(c.id === undefined ? {} : { id: c.id }), name: c.name, args: c.arguments } }),
    mcp: () => ({ name: c.name, arguments: c.arguments }),
  };
  const write = written[to];
  if (!write) throw new ToolShapeError(`unknown target format "${String(to)}". Use one of: ${FORMATS.join(", ")}.`);
  return write();
}

let counter = 0;
function generatedId(to: Format): string {
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  counter = (counter + 1) % 1e6;
  return `${to === "anthropic" ? "toolu_" : "call_"}${random}${counter.toString(36)}`;
}

export interface ToolResultOptions {
  /** The id of the call this answers. Required for OpenAI, Responses and Anthropic. */
  id?: string;
  /** The tool's name. Required for Gemini. */
  name?: string;
  /** The tool failed: Anthropic `is_error`, MCP `isError`, Gemini `{ error }`, and an `Error: ` prefix for OpenAI. */
  isError?: boolean;
}

export type OpenAIToolResult = { role: "tool"; tool_call_id: string; content: string };
export type OpenAIResponsesToolResult = { type: "function_call_output"; call_id: string; output: string };
export type AnthropicToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: true };
export type GeminiToolResult = { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };
export type MCPToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: true };

type ConvertedResult = {
  openai: OpenAIToolResult;
  "openai-responses": OpenAIResponsesToolResult;
  anthropic: AnthropicToolResult;
  gemini: GeminiToolResult;
  mcp: MCPToolResult;
};

/**
 * Wrap a tool's result for the `to` format: an OpenAI `tool` message, a Responses `function_call_output` item,
 * an Anthropic `tool_result` block (put it in a user message), a Gemini `functionResponse` part, or an MCP
 * `CallToolResult`. Strings are sent as is; anything else as JSON.
 */
export function toolResult<F extends Format>(result: unknown, to: F, options: ToolResultOptions = {}): ConvertedResult[F] {
  const text = typeof result === "string" ? result : (JSON.stringify(result) ?? String(result));
  const needId = () => {
    if (!options.id) throw new ToolShapeError(`a ${to} tool result needs the id of the call it answers: pass { id }.`);
    return options.id;
  };
  const written: { [K in Format]: () => ConvertedResult[K] } = {
    openai: () => ({ role: "tool", tool_call_id: needId(), content: options.isError ? `Error: ${text}` : text }),
    "openai-responses": () => ({ type: "function_call_output", call_id: needId(), output: options.isError ? `Error: ${text}` : text }),
    anthropic: () => ({ type: "tool_result", tool_use_id: needId(), content: text, ...(options.isError ? { is_error: true as const } : {}) }),
    gemini: () => {
      if (!options.name) throw new ToolShapeError(`a gemini tool result needs the tool's name: pass { name }.`);
      // Gemini wants an object; it reads `output` and `error` keys by convention.
      const response = options.isError ? { error: result } : isObject(result) ? result : { output: result };
      return { functionResponse: { ...(options.id === undefined ? {} : { id: options.id }), name: options.name, response } };
    },
    mcp: () => ({
      content: [{ type: "text", text }],
      ...(isObject(result) && !options.isError ? { structuredContent: result } : {}),
      ...(options.isError ? { isError: true as const } : {}),
    }),
  };
  const write = written[to];
  if (!write) throw new ToolShapeError(`unknown target format "${String(to)}". Use one of: ${FORMATS.join(", ")}.`);
  return write();
}

function describe(v: unknown): string {
  const text = JSON.stringify(v);
  return text === undefined ? String(v) : text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
