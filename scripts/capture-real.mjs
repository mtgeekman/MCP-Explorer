// Capture a REAL MCP server and print what we made of it.
//
// The fixtures are only trustworthy if they agree with reality: a fixture built
// to match the client proves nothing. This is the manual check that the capture
// layer works against servers nobody here wrote.
//
//   node scripts/capture-real.mjs npx -y @modelcontextprotocol/server-everything
//
// Deliberately not a test: it needs the network and an npm fetch, so it must
// not gate CI.
import { connectStdio, captureSurface, hashSurface } from '../packages/protocol/dist/index.js';
const [cmd, ...args] = process.argv.slice(2);
const conn = await connectStdio({ command: cmd, args, probeTimeoutMs: 8000 });
const s = await captureSurface(conn.source);
await conn.close();
console.log(JSON.stringify({
  era: conn.era, revision: conn.revision,
  server: `${s.serverName}@${s.serverVersion}`,
  tools: s.tools.length, prompts: s.prompts.length, resources: s.resources.length, templates: s.resourceTemplates.length,
  problems: s.problems, hash: hashSurface(s).slice(0, 12),
  sampleTool: s.tools[0] ? { name: s.tools[0].name, hasSchema: !!s.tools[0].inputSchema, hasAnnotations: !!s.tools[0].annotations } : null,
}, null, 1));
