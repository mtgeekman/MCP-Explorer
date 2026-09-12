# MCP Explorer

A desktop workbench for MCP servers. Connect to local `stdio` servers and
remote HTTP servers, see everything an agent would see, call the tools by
hand, and find out what a release actually changed.

**Status: Phase 01 complete (2026-09-11).** The toolchain is proven end to end
-- an Electron app builds and packages on Windows and Linux from CI -- and the
protocol core exists: it connects to a server over any of the three transports,
detects the protocol era, captures the whole surface, and diffs it across
versions. There is no user interface yet. Phase 02 builds storage.

## What it does

- Connects over `stdio`, Streamable HTTP, and the deprecated HTTP+SSE
  transport, with bearer/header auth or full OAuth 2.1.
- Shows the complete agent-facing surface: server instructions, tools with
  their schemas and annotations, prompts, resources and resource templates.
- Renders the **context preview** — the exact block a client would hand a
  model, across every server in a workspace — and what it costs in tokens.
- Calls tools through forms generated from their schemas, with a raw JSON
  editor always available beside the form.
- Speaks **every published protocol revision**, 2024-11-05 through
  2026-07-28, including surfaces later revisions deprecated. A tool that only
  opens the newest thing is not an explorer.
- Answers the server's own requests with a human in the loop: when a server
  asks for sampling, you type the completion yourself — whether it asks the
  old way or through a modern multi-round-trip call.
- Logs every JSON-RPC frame, raw, in both directions.
- Stores every version of every server's surface and diffs them, including
  a diff of the rendered context block and the token delta.

## What it is not

Not a harness for testing servers with an AI model. There is no model, no
API key, and no background activity: what you see, you caused. Driving the
servers with a real agent is a separate, deliberately deferred enhancement.

## Platforms

Windows and Linux. macOS is deferred pending build hardware; the code is
written not to foreclose it.

## Documentation

Everything lives in the wiki under `claude/projects/mcp-explorer`:

- **spec** — goal, pillars, constraints, non-goals, 17 decision blocks,
  verifiers
- **plans/v1-development-plan** — twelve phases, sequencing rationale, risks
- **reference/** — runbooks and design records
- **enhancements/** — proposed work with the case for it

Working conventions for this tree are in `CLAUDE.md`.
