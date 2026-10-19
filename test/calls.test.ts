import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  convertAll,
  convertToolCall,
  fromStrictArgs,
  isToolCall,
  readToolCall,
  readToolCalls,
  toolResult,
  ToolShapeError,
} from "../dist/index.js";

const args = { city: "Oslo", unit: "c" };

const calls = {
  openai: { id: "call_1", type: "function", function: { name: "get_weather", arguments: JSON.stringify(args) } },
  "openai-responses": { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: JSON.stringify(args) },
  anthropic: { type: "tool_use", id: "call_1", name: "get_weather", input: args },
  gemini: { functionCall: { id: "call_1", name: "get_weather", args } },
  mcp: { method: "tools/call", params: { name: "get_weather", arguments: args }, id: "call_1" },
} as const;

describe("readToolCall", () => {
  it("reads a call in every format into the same neutral form", () => {
    for (const [format, call] of Object.entries(calls)) {
      assert.deepEqual(readToolCall(call), { id: "call_1", name: "get_weather", arguments: args }, format);
      assert.ok(isToolCall(call), format);
    }
    assert.deepEqual(readToolCall({ name: "get_weather", args }), { name: "get_weather", arguments: args });
    assert.deepEqual(readToolCall({ name: "get_weather", arguments: args }), { name: "get_weather", arguments: args });
  });

  it("treats empty arguments as {} and rejects broken ones", () => {
    assert.deepEqual(readToolCall({ id: "c", type: "function", function: { name: "ping", arguments: "" } }).arguments, {});
    assert.throws(
      () => readToolCall({ id: "c", type: "function", function: { name: "ping", arguments: '{"a":' } }),
      (e: unknown) => e instanceof ToolShapeError && /arguments of the call to "ping" aren't valid JSON/.test(e.message),
    );
    assert.throws(() => readToolCall({ type: "text", text: "hi" }), ToolShapeError);
  });
});

describe("readToolCalls", () => {
  it("finds the calls in each provider's response and skips everything else", () => {
    const expected = [
      { id: "a", name: "one", arguments: {} },
      { id: "b", name: "two", arguments: { x: 1 } },
    ];
    const chat = {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Calling tools",
            tool_calls: [
              { id: "a", type: "function", function: { name: "one", arguments: "{}" } },
              { id: "b", type: "function", function: { name: "two", arguments: '{"x":1}' } },
            ],
          },
        },
      ],
    };
    const responses = {
      output: [
        { type: "reasoning", id: "rs", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
        { type: "function_call", call_id: "a", name: "one", arguments: "{}" },
        { type: "function_call", call_id: "b", name: "two", arguments: '{"x":1}' },
      ],
    };
    const anthropic = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm", signature: "s" },
        { type: "text", text: "hi" },
        { type: "tool_use", id: "a", name: "one", input: {} },
        { type: "tool_use", id: "b", name: "two", input: { x: 1 } },
      ],
    };
    const gemini = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "hi" }, { functionCall: { id: "a", name: "one", args: {} } }, { functionCall: { id: "b", name: "two", args: { x: 1 } } }],
          },
        },
      ],
    };
    for (const [name, response] of Object.entries({ chat, responses, anthropic, gemini })) {
      assert.deepEqual(readToolCalls(response), expected, name);
    }
    assert.deepEqual(readToolCalls(chat.choices[0]!.message), expected);
    assert.deepEqual(readToolCalls(anthropic.content), expected);
    assert.deepEqual(readToolCalls({ role: "assistant", content: "no tools" }), []);
    assert.deepEqual(readToolCalls({ choices: [{ message: { role: "assistant", content: "plain" } }] }), []);
  });

  it("maps renamed tools back and removes the nulls strict mode added", () => {
    const original = [
      {
        name: "github.search",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer" },
            cursor: { type: ["string", "null"] },
            filters: {
              type: "object",
              properties: { label: { type: "string" }, state: { type: "string" } },
              required: ["state"],
            },
            tags: { type: "array", items: { type: "object", properties: { name: { type: "string" }, color: { type: "string" } } } },
          },
          required: ["query"],
        },
      },
    ];
    const { tools, renamed } = convertAll(original, "openai", { strict: true });
    assert.equal(tools[0]!.function.name, "github_search");
    const fromModel = {
      id: "c1",
      type: "function",
      function: {
        name: "github_search",
        arguments: JSON.stringify({
          query: "bug",
          limit: null,
          cursor: null,
          filters: { label: null, state: "open" },
          tags: [{ name: "x", color: null }],
        }),
      },
    };
    assert.deepEqual(readToolCall(fromModel, { renamed, tools: original }), {
      id: "c1",
      name: "github.search",
      arguments: { query: "bug", cursor: null, filters: { state: "open" }, tags: [{ name: "x" }] },
    });
    // Without the original tools, arguments are left alone.
    assert.equal(readToolCall(fromModel, { renamed }).arguments.limit, null);
  });

  it("fromStrictArgs follows $refs, anyOf branches and required nulls", () => {
    const schema = {
      type: "object",
      $defs: { Address: { type: "object", properties: { street: { type: "string" }, zip: { type: "string" } }, required: ["street"] } },
      properties: {
        home: { $ref: "#/$defs/Address" },
        work: { anyOf: [{ $ref: "#/$defs/Address" }, { type: "null" }] },
        note: { type: "string" },
        anything: {},
      },
      required: ["note"],
    };
    assert.deepEqual(
      fromStrictArgs({ home: { street: "Main", zip: null }, work: { street: "Dock", zip: null }, note: null, anything: null }, schema),
      { home: { street: "Main" }, work: { street: "Dock" }, note: null, anything: null },
    );
  });
});

describe("convertToolCall", () => {
  it("writes a call in every format, and back", () => {
    for (const [to, expected] of Object.entries(calls)) {
      if (to === "mcp") continue;
      const written = convertToolCall(calls.anthropic, to as keyof typeof calls);
      if (to === "openai-responses") assert.deepEqual(written, { type: "function_call", call_id: "call_1", name: "get_weather", arguments: JSON.stringify(args) });
      else assert.deepEqual(written, expected, to);
      assert.deepEqual(readToolCall(written), { id: "call_1", name: "get_weather", arguments: args });
    }
    assert.deepEqual(convertToolCall(calls.openai, "mcp"), { name: "get_weather", arguments: args });
  });

  it("generates ids where the target needs one", () => {
    const fromGemini = { functionCall: { name: "ping", args: {} } };
    const openai = convertToolCall(fromGemini, "openai");
    const anthropic = convertToolCall(fromGemini, "anthropic");
    assert.match(openai.id, /^call_/);
    assert.match(anthropic.id, /^toolu_/);
    assert.notEqual(convertToolCall(fromGemini, "openai").id, openai.id);
    assert.deepEqual(convertToolCall(fromGemini, "gemini"), fromGemini);
  });
});

describe("toolResult", () => {
  it("wraps results for each provider", () => {
    const result = { temp: 4, sky: "rain" };
    assert.deepEqual(toolResult(result, "openai", { id: "call_1" }), { role: "tool", tool_call_id: "call_1", content: '{"temp":4,"sky":"rain"}' });
    assert.deepEqual(toolResult("4 C", "openai-responses", { id: "call_1" }), { type: "function_call_output", call_id: "call_1", output: "4 C" });
    assert.deepEqual(toolResult("4 C", "anthropic", { id: "call_1" }), { type: "tool_result", tool_use_id: "call_1", content: "4 C" });
    assert.deepEqual(toolResult(result, "gemini", { name: "get_weather" }), { functionResponse: { name: "get_weather", response: result } });
    assert.deepEqual(toolResult("4 C", "gemini", { name: "get_weather", id: "c" }), {
      functionResponse: { id: "c", name: "get_weather", response: { output: "4 C" } },
    });
    assert.deepEqual(toolResult(result, "mcp"), { content: [{ type: "text", text: '{"temp":4,"sky":"rain"}' }], structuredContent: result });
  });

  it("marks errors and insists on ids and names", () => {
    assert.deepEqual(toolResult("City not found", "anthropic", { id: "t", isError: true }), {
      type: "tool_result",
      tool_use_id: "t",
      content: "City not found",
      is_error: true,
    });
    assert.equal(toolResult("City not found", "openai", { id: "t", isError: true }).content, "Error: City not found");
    assert.deepEqual(toolResult("City not found", "gemini", { name: "w", isError: true }).functionResponse.response, { error: "City not found" });
    assert.deepEqual(toolResult("City not found", "mcp", { isError: true }), { content: [{ type: "text", text: "City not found" }], isError: true });
    assert.throws(() => toolResult("x", "openai"), /needs the id of the call/);
    assert.throws(() => toolResult("x", "gemini"), /needs the tool's name/);
  });
});
