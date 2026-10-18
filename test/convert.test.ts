import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  convert,
  convertAll,
  detectFormat,
  fromGeminiSchema,
  toAnthropic,
  toGemini,
  toMCP,
  toOpenAI,
  toOpenAIResponses,
  toStrictSchema,
  toTool,
  ToolShapeError,
} from "../dist/index.js";

const params = {
  type: "object",
  properties: {
    city: { type: "string", description: "City name" },
    unit: { type: "string", enum: ["c", "f"] },
  },
  required: ["city"],
};

const openai = { type: "function", function: { name: "get_weather", description: "Get the weather", parameters: params } };
const responses = { type: "function", name: "get_weather", description: "Get the weather", parameters: params, strict: false };
const anthropic = { name: "get_weather", description: "Get the weather", input_schema: params };
const mcp = { name: "get_weather", description: "Get the weather", inputSchema: params };
const gemini = {
  name: "get_weather",
  description: "Get the weather",
  parameters: {
    type: "OBJECT",
    properties: {
      city: { type: "STRING", description: "City name" },
      unit: { type: "STRING", enum: ["c", "f"], format: "enum" },
    },
    required: ["city"],
  },
};

describe("detectFormat", () => {
  it("recognises each format", () => {
    assert.equal(detectFormat(openai), "openai");
    assert.equal(detectFormat(responses), "openai-responses");
    assert.equal(detectFormat(anthropic), "anthropic");
    assert.equal(detectFormat(mcp), "mcp");
    assert.equal(detectFormat(gemini), "gemini");
    assert.equal(detectFormat({ functionDeclarations: [gemini] }), "gemini");
  });

  it("explains what it can't read", () => {
    assert.throws(() => detectFormat({ type: "web_search" }), /built-in tool/);
    assert.throws(() => detectFormat([]), ToolShapeError);
    assert.throws(() => detectFormat({ foo: 1 }), /can't tell what format this is/);
  });
});

describe("round trips", () => {
  const sources = { openai, responses, anthropic, mcp, gemini };
  for (const [from, tool] of Object.entries(sources)) {
    it(`${from} -> every format reads back the same`, () => {
      const neutral = toTool(tool);
      assert.equal(neutral.name, "get_weather");
      assert.equal(neutral.description, "Get the weather");
      assert.deepEqual(neutral.parameters, params);
      assert.deepEqual(toAnthropic(tool), anthropic);
      assert.deepEqual(toMCP(tool), mcp);
      assert.deepEqual(toOpenAI(tool).function.parameters, params);
      assert.deepEqual(toOpenAIResponses(tool), responses);
    });
  }

  it("writes Gemini's schema subset", () => {
    assert.deepEqual(toGemini(openai), {
      name: "get_weather",
      description: "Get the weather",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          unit: { type: "string", enum: ["c", "f"], format: "enum" },
        },
        required: ["city"],
      },
    });
    assert.equal(toGemini(openai, { upperCaseTypes: true }).parameters?.type, "OBJECT");
    assert.deepEqual(toGemini(openai, { jsonSchema: true }).parametersJsonSchema, params);
  });
});

describe("Gemini schema conversion", () => {
  function gem(schema: object) {
    const warnings: string[] = [];
    const out = toGemini({ name: "t", input_schema: { type: "object", properties: { x: schema } } }, { onWarning: (w) => warnings.push(w) });
    return { x: (out.parameters?.properties as Record<string, unknown>).x, warnings };
  }

  it("turns nullable type arrays into nullable", () => {
    assert.deepEqual(gem({ type: ["string", "null"] }).x, { type: "string", nullable: true });
    assert.deepEqual(gem({ anyOf: [{ type: "integer" }, { type: "null" }] }).x, { type: "integer", nullable: true });
    assert.deepEqual(gem({ type: ["string", "number"] }).x, { anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("inlines $refs and handles recursion", () => {
    const tool = {
      name: "tree",
      input_schema: {
        type: "object",
        properties: { root: { $ref: "#/$defs/node" } },
        $defs: { node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/$defs/node" } } } },
      },
    };
    const warnings: string[] = [];
    const out = toGemini(tool, { onWarning: (w) => warnings.push(w) });
    assert.deepEqual(out.parameters, {
      type: "object",
      properties: {
        root: { type: "object", properties: { name: { type: "string" }, child: { type: "object" } } },
      },
    });
    assert.ok(warnings.some((w) => /recursive \$ref/.test(w)));
  });

  it("drops what Gemini rejects, with warnings", () => {
    const { x, warnings } = gem({
      type: "object",
      properties: { email: { type: "string", format: "email" }, n: { type: "integer", const: 3 } },
      additionalProperties: false,
      $schema: "x",
      patternProperties: {},
    });
    assert.deepEqual(x, { type: "object", properties: { email: { type: "string" }, n: { type: "integer" } } });
    assert.ok(warnings.some((w) => /format "email" dropped/.test(w)));
    assert.ok(warnings.some((w) => /const 3 dropped/.test(w)));
    assert.ok(warnings.some((w) => /dropped keywords Gemini doesn't support: patternProperties/.test(w)));
  });

  it("converts const, oneOf, allOf and exclusive bounds", () => {
    assert.deepEqual(gem({ const: "fixed" }).x, { enum: ["fixed"], type: "string", format: "enum" });
    assert.deepEqual(gem({ oneOf: [{ type: "string" }, { type: "number" }] }).x, { anyOf: [{ type: "string" }, { type: "number" }] });
    assert.deepEqual(
      gem({ allOf: [{ properties: { a: { type: "string" } }, required: ["a"] }, { properties: { b: { type: "number" } } }] }).x,
      { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
    );
    assert.deepEqual(gem({ type: "number", exclusiveMinimum: 0 }).x, { type: "number", minimum: 0 });
  });

  it("omits parameters for tools without arguments", () => {
    assert.deepEqual(toGemini({ name: "ping", description: "Ping", input_schema: { type: "object", properties: {} } }), {
      name: "ping",
      description: "Ping",
    });
  });

  it("reads Gemini schemas back to JSON Schema", () => {
    assert.deepEqual(
      fromGeminiSchema({ type: "OBJECT", properties: { a: { type: "STRING", nullable: true }, b: { type: "ARRAY", items: { type: "INTEGER" }, minItems: "1" } }, propertyOrdering: ["a", "b"] }),
      { type: "object", properties: { a: { type: ["string", "null"] }, b: { type: "array", items: { type: "integer" }, minItems: 1 } } },
    );
  });
});

describe("OpenAI strict mode", () => {
  it("requires every property and makes optional ones nullable", () => {
    const out = toOpenAI(anthropic, { strict: true });
    assert.equal(out.function.strict, true);
    assert.deepEqual(out.function.parameters, {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        unit: { type: ["string", "null"], enum: ["c", "f", null] },
      },
      required: ["city", "unit"],
      additionalProperties: false,
    });
  });

  it("walks nested objects, arrays and $defs", () => {
    const schema = toStrictSchema(
      {
        type: "object",
        properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } }, ref: { $ref: "#/$defs/x" } },
        $defs: { x: { type: "object", properties: { y: { type: "number" } }, required: ["y"] } },
      },
      () => {},
    );
    const items = (schema.properties as any).items.items;
    assert.deepEqual(items.required, ["id"]);
    assert.equal(items.additionalProperties, false);
    assert.deepEqual((schema.properties as any).ref, { anyOf: [{ $ref: "#/$defs/x" }, { type: "null" }] });
    assert.equal((schema.$defs as any).x.additionalProperties, false);
  });

  it("Responses tools default to strict: false", () => {
    assert.equal(toOpenAIResponses(anthropic).strict, false);
    assert.equal(toOpenAIResponses(anthropic, { strict: true }).parameters.additionalProperties, false);
  });
});

describe("names and lists", () => {
  it("renames tools the target rejects and reports it", () => {
    const warnings: string[] = [];
    const out = convert({ name: "github.create issue", inputSchema: params }, "openai", { onWarning: (w) => warnings.push(w) });
    assert.equal(out.function.name, "github_create_issue");
    assert.match(warnings[0]!, /renamed to "github_create_issue"/);
    assert.equal(convert({ name: "github.create", inputSchema: params }, "gemini").name, "github.create");
    assert.equal(convert({ name: "1st", inputSchema: params }, "gemini").name, "_1st");
  });

  it("convertAll keeps names unique, maps renames back and wraps Gemini tools", () => {
    const result = convertAll(
      { tools: [{ name: "a.b", inputSchema: params }, { name: "a_b", inputSchema: params }, { name: "c", inputSchema: params }] },
      "anthropic",
    );
    assert.deepEqual(
      result.tools.map((t) => t.name),
      ["a_b", "a_b_2", "c"],
    );
    assert.deepEqual(result.renamed, { a_b: "a.b", a_b_2: "a_b" });
    assert.equal(result.warnings.length, 2);
    const g = convertAll([openai, anthropic], "gemini");
    assert.equal(g.tools.length, 1);
    assert.equal(g.tools[0].functionDeclarations.length, 2);
    const back = convertAll(g.tools, "mcp");
    assert.equal(back.tools.length, 2);
  });

  it("fills in missing parameters and rejects non-object ones", () => {
    assert.deepEqual(toAnthropic({ name: "noop", description: "No args" }).input_schema, { type: "object", properties: {} });
    assert.throws(() => toAnthropic({ name: "x", input_schema: { type: "string" } }), /must be an object schema/);
  });

  it("keeps MCP metadata between MCP tools but drops it elsewhere", () => {
    const rich = { name: "read", title: "Read file", inputSchema: params, outputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
    assert.deepEqual(toMCP(rich), rich);
    assert.deepEqual(Object.keys(toAnthropic(rich)), ["name", "input_schema"]);
  });
});

describe("cli", () => {
  const CLI = join(import.meta.dirname, "..", "dist", "cli.js");
  const run = (args: string[], input: string) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8" });

  it("converts stdin and prints warnings to stderr", () => {
    const r = run(["--to", "gemini"], JSON.stringify([{ name: "a", input_schema: { type: "object", properties: { e: { type: "string", format: "uri" } } } }]));
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), [{ functionDeclarations: [{ name: "a", parameters: { type: "object", properties: { e: { type: "string" } } } }] }]);
    assert.match(r.stderr, /warning: a: parameters.e: format "uri" dropped/);
  });

  it("reports bad input", () => {
    assert.equal(run(["--to", "nope"], "{}").status, 2);
    assert.equal(run(["--to", "openai"], "not json").status, 2);
    const r = run(["--to", "openai"], JSON.stringify({ type: "code_interpreter" }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /built-in tool/);
  });
});
