#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { convertAll, FORMATS, ToolShapeError, type ConvertOptions, type Format } from "./index.js";

const HELP = `toolshape - convert LLM tool definitions between formats

Usage:
  toolshape --to <format> [file] [options]
  cat tools.json | toolshape --to gemini

Reads a tool, an array of tools, a Gemini tool ({ "functionDeclarations": [...] })
or an MCP tools/list result ({ "tools": [...] }) in any supported format, and
prints the converted tools as JSON. Warnings go to stderr.

Formats: ${FORMATS.join(", ")}

Options:
  -t, --to <format>     Target format (required).
      --strict          OpenAI: make schemas strict-mode compatible.
      --json-schema     Gemini: emit parametersJsonSchema instead of converting.
      --upper-types     Gemini: write types as STRING, OBJECT...
      --keep-names      Don't rename tools whose names the target rejects.
  -q, --quiet           Don't print warnings.
  -h, --help            Show this help.
  -v, --version         Show the version number.

Examples:
  toolshape --to anthropic openai-tools.json
  toolshape --to openai --strict mcp-tools.json > tools.json
`;

class UsageError extends Error {}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function run(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: "string", short: "t" },
        strict: { type: "boolean" },
        "json-schema": { type: "boolean" },
        "upper-types": { type: "boolean" },
        "keep-names": { type: "boolean" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (!values.to) throw new UsageError(`missing --to <format>. Formats: ${FORMATS.join(", ")}.`);
  if (!(FORMATS as readonly string[]).includes(values.to)) {
    throw new UsageError(`unknown format "${values.to}". Formats: ${FORMATS.join(", ")}.`);
  }
  if (positionals.length > 1) throw new UsageError("pass one file at a time.");
  const file = positionals[0] ?? "-";
  if (file === "-" && process.stdin.isTTY) throw new UsageError("no input. Pass a file or pipe JSON into stdin.");

  let text: string;
  try {
    text = readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UsageError(code === "ENOENT" ? `can't find "${file}".` : `can't read "${file}": ${(error as Error).message}`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file === "-" ? "stdin" : file} is not valid JSON: ${(error as Error).message}`);
  }

  const options: ConvertOptions = {};
  if (values.strict) options.strict = true;
  if (values["json-schema"]) options.jsonSchema = true;
  if (values["upper-types"]) options.upperCaseTypes = true;
  if (values["keep-names"]) options.sanitizeNames = false;
  const result = convertAll(input, values.to as Format, options);
  if (!values.quiet) for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(`${JSON.stringify(result.tools, null, 2)}\n`);
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError || error instanceof ToolShapeError) {
    const message = error.message.replace(/^toolshape: /, "");
    process.stderr.write(`toolshape: ${message}\n${error instanceof UsageError ? 'Run "toolshape --help" for usage.\n' : ""}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  } else {
    throw error;
  }
}
