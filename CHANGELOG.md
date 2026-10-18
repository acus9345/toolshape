# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-18

### Added

- `convert()` and `toOpenAI()`, `toOpenAIResponses()`, `toAnthropic()`, `toGemini()`, `toMCP()` convert a tool definition from any of those formats to any other, detecting the source format.
- `convertAll()` converts lists, Gemini tools and MCP `tools/list` results, collects warnings, keeps renamed tools unique and returns a map back to the original names.
- Gemini schema conversion: `$ref` inlining (recursion-safe), nullable unions, `const`, `oneOf`, `allOf` and exclusive bounds rewritten, unsupported formats and keywords dropped with warnings, `parameters` omitted for tools without arguments, optional uppercase types or `parametersJsonSchema`.
- OpenAI strict mode conversion; Responses API tools default to `strict: false`.
- Tool names fixed per target's rules.
- `toolshape` CLI.

[0.1.0]: https://github.com/acus9345/toolshape/releases/tag/v0.1.0
