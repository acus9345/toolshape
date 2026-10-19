# toolshape

Convert LLM tool definitions, tool calls and tool results between OpenAI, Anthropic, Gemini and MCP formats. Zero dependencies.

[![npm](https://img.shields.io/npm/v/toolshape)](https://www.npmjs.com/package/toolshape)
[![CI](https://github.com/acus9345/toolshape/actions/workflows/ci.yml/badge.svg)](https://github.com/acus9345/toolshape/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/toolshape)](LICENSE)

Every provider wants the same tool described a little differently, and the differences are more than renamed keys. Gemini only accepts a subset of JSON Schema. OpenAI strict mode wants every property required. MCP tool names can contain dots that OpenAI rejects. `toolshape` handles the wrapping and those schema fixes, and tells you whenever something couldn't be carried over exactly.

- **Five formats:** OpenAI Chat Completions, OpenAI Responses, Anthropic, Gemini, MCP. Reads any of them, writes any of them.
- **Gemini schema fixes:** `$ref`s inlined, `["string", "null"]` becomes `nullable`, `const` and `oneOf` rewritten, unsupported formats and keywords dropped with a warning.
- **OpenAI strict mode:** `additionalProperties: false` everywhere, all properties required, optional ones made nullable.
- **Tool names:** invalid names are fixed per target and kept unique, with a map back to the originals for routing tool calls.
- **Tool calls and results:** read the calls in any provider's response, get the original names and arguments back, and wrap your tool's result the way each provider expects.
- Includes a CLI.

## Install

```bash
npm install toolshape
```

## Quick start

```js
import { convert } from "toolshape";

const tool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
        unit: { type: ["string", "null"], enum: ["c", "f", null] },
      },
      required: ["city"],
    },
  },
};

console.log(convert(tool, "anthropic").input_schema.properties.unit);
console.log(convert(tool, "gemini").parameters.properties.unit);
```

```js
{ type: [ 'string', 'null' ], enum: [ 'c', 'f', null ] }
{ type: 'string', enum: [ 'c', 'f' ], format: 'enum', nullable: true }
```

Anthropic takes the schema as is, under `input_schema`. Gemini has no `null` type, so the nullable union becomes `nullable: true` and the string enum gets the `format: "enum"` Gemini expects.

The source format is detected automatically, so the same call works whether `tool` came from OpenAI, Anthropic, Gemini or an MCP server.

## Many tools at once

`convertAll` takes an array (formats can be mixed), a Gemini tool with `functionDeclarations`, or an MCP `tools/list` result, and collects warnings instead of making you pass a callback:

```js
import { convertAll } from "toolshape";

const { tools: mcpTools } = await mcpClient.listTools();
const { tools, warnings, renamed } = convertAll(mcpTools, "openai", { strict: true });

for (const w of warnings) console.warn(w);

// Later, map the model's tool call back to the MCP tool name:
const mcpName = renamed[call.function.name] ?? call.function.name;
```

For Gemini, `tools` is `[{ functionDeclarations: [...] }]`, ready to pass as `config.tools`.

## Tool calls and results

Converting the definitions is only half the job. The model's tool calls also come back in the provider's own format, under the name you registered with that provider. In strict mode they also carry a `null` for every argument the model left out. `readToolCalls` handles all three:

```js
import { convertAll, readToolCalls, toolResult } from "toolshape";

const { tools: mcpTools } = await mcpClient.listTools();
const { tools, renamed } = convertAll(mcpTools, "openai", { strict: true });

const completion = await openai.chat.completions.create({ model: "gpt-5", messages, tools });
messages.push(completion.choices[0].message);

for (const call of readToolCalls(completion, { renamed, tools: mcpTools })) {
  // call.name is the MCP name again ("github.search", not "github_search"), and the nulls
  // strict mode forced into optional arguments are gone.
  const result = await mcpClient.callTool({ name: call.name, arguments: call.arguments });
  messages.push(toolResult(result.structuredContent ?? result.content, "openai", { id: call.id }));
}
```

`readToolCalls` accepts any of these:
- an OpenAI chat completion or assistant message
- a Responses API response
- an Anthropic message
- a Gemini response
- a list of calls

It skips text and reasoning. Every call comes back as `{ id?, name, arguments }`, with the arguments parsed.

| Function | Returns |
| --- | --- |
| `readToolCalls(response, options?)` | Every tool call in a response, as `{ id?, name, arguments }`. |
| `readToolCall(call, options?)` | One call, in any format. |
| `convertToolCall(call, to)` | The call in another format, for replaying a conversation to a different provider. OpenAI and Anthropic get a generated id if the call had none. `mcp` gives `tools/call` params. |
| `toolResult(result, to, { id?, name?, isError? })` | An OpenAI `tool` message, a Responses `function_call_output`, an Anthropic `tool_result` block, a Gemini `functionResponse` part or an MCP `CallToolResult`. Strings are sent as is, anything else as JSON. |
| `fromStrictArgs(args, originalSchema)` | The arguments without the `null`s strict mode added, at every depth. A `null` the original schema allows is kept. |
| `isToolCall(value)` | Whether a value looks like a tool call. |

`readToolCalls` takes two options:
- `renamed` (from `convertAll`) maps names back.
- `tools` (the original definitions, in any format) turns on the strict-mode cleanup.

`toolResult` needs `id` for OpenAI, Responses and Anthropic, and `name` for Gemini. With `isError`:
- Anthropic gets `is_error`.
- MCP gets `isError`.
- Gemini gets `{ error }`.
- OpenAI gets an `Error: ` prefix.

## API

| Function | Returns |
| --- | --- |
| `convert(tool, to, options?)` | One tool in the `to` format. |
| `convertAll(input, to, options?)` | `{ tools, warnings, renamed }`. |
| `toOpenAI(tool, options?)` | `{ type: "function", function: { name, description, parameters, strict? } }` |
| `toOpenAIResponses(tool, options?)` | `{ type: "function", name, description, parameters, strict }` |
| `toAnthropic(tool, options?)` | `{ name, description, input_schema }` |
| `toGemini(tool, options?)` | `{ name, description, parameters }` (a function declaration) |
| `toMCP(tool, options?)` | `{ name, title?, description, inputSchema, outputSchema?, annotations? }` |
| `toTool(tool)` / `toTools(input)` | The provider-neutral `{ name, description, parameters, ... }` form. |
| `detectFormat(tool)` | `"openai"`, `"openai-responses"`, `"anthropic"`, `"gemini"` or `"mcp"`. |

`to` is one of `"openai"`, `"openai-responses"`, `"anthropic"`, `"gemini"`, `"mcp"`.

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `strict` | source's value | OpenAI: make the schema strict-mode compatible and set `strict: true`. |
| `jsonSchema` | `false` | Gemini: put the untouched JSON Schema in `parametersJsonSchema` instead of converting it to `parameters`. |
| `upperCaseTypes` | `false` | Gemini: write `"STRING"`, `"OBJECT"`... like the Google SDK's `Type` enum. |
| `sanitizeNames` | `true` | Fix tool names the target rejects (`github.create_issue` becomes `github_create_issue` for OpenAI). |
| `onWarning` | none | Called with a message for everything that couldn't be carried over exactly. |

The schema helpers are exported too: `toGeminiSchema`, `fromGeminiSchema`, `toStrictSchema` and `inlineRefs`.

## What changes between formats

| | OpenAI | Responses | Anthropic | Gemini | MCP |
| --- | --- | --- | --- | --- | --- |
| Name characters | `a-z A-Z 0-9 _ -` | same | same | also `. :`, must start with a letter or `_` | also `.` |
| Name length | 64 | 64 | 128 | 64 | 128 |
| Schema | JSON Schema | JSON Schema | JSON Schema | OpenAPI subset (or `parametersJsonSchema`) | JSON Schema |
| Tool without arguments | `{ type: "object", properties: {} }` | same | same | `parameters` omitted | same as OpenAI |

A few behaviours worth knowing:

- **Responses API tools get `strict: false`** unless you ask for strict. The Responses API treats a missing `strict` as `true`, which rejects most hand-written schemas.
- **MCP `title`, `outputSchema` and `annotations`** have no equivalent elsewhere. They're kept between MCP tools and silently dropped for other targets.
- **Built-in tools** like OpenAI's `web_search` or Anthropic's `computer` aren't function tools, so `toolshape` throws a `ToolShapeError` for them instead of guessing.

## CLI

```bash
npx toolshape --to anthropic openai-tools.json
npx toolshape --to openai --strict mcp-tools.json > tools.json
cat tools.json | npx toolshape --to gemini --upper-types
```

The input can be one tool, an array, a Gemini tool or an MCP `tools/list` result. Converted tools go to stdout as JSON and warnings go to stderr:

```
warning: send_email: parameters.to: format "email" dropped (Gemini supports enum, date-time for string).
```

Exit codes: `0` converted, `1` the input isn't a tool toolshape can read, `2` bad usage. Run `npx toolshape --help` for all options.

## License

MIT
