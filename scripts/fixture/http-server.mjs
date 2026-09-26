// Streamable HTTP fixture, serving the SAME handler as the stdio server.
//
// Prints its listening URL on stdout as `LISTENING <url>` so a test can start
// it without guessing a port.
//
// Modes, for the wire log's byte-exact tests (D34, D35):
//   SSE_REPLIES  answer each POST with an event stream instead of a JSON body:
//                a comment, then the response as one event with CRLF line
//                endings, written a few bytes at a time.
//   HTML_REPLY   answer every POST with a 502 HTML page, as a proxy in front
//                of a dead server would.
//   WIRE_LOG     append every response body written, as hex, one per line.
//   HEADER_LOG   append the Authorization header each request carried.
//   LEGACY       serve the legacy-era handler instead of the modern one; its
//                hostile modes die by dropping the connection, or hang.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { handleModern } from './modern-handler.mjs';
import { handleLegacy, DIE, SILENT } from './legacy-handler.mjs';
import { answerer } from './call-handler.mjs';
import { serverMeta } from './modern-handler.mjs';

// CALL_TOOLS calls are answered here too; a progress notification is dropped,
// since a JSON body carries one message. Progress is exercised over stdio.
const handle = answerer(process.env.LEGACY ? handleLegacy : handleModern, () => (process.env.LEGACY ? {} : { resultType: 'complete', ...serverMeta() }));

const endpoint = '/mcp';

function writeBody(res, bytes, chunkSize) {
  if (process.env.WIRE_LOG) appendFileSync(process.env.WIRE_LOG, `${bytes.toString('hex')}\n`);
  if (!chunkSize) return res.end(bytes);
  for (let i = 0; i < bytes.length; i += chunkSize) res.write(bytes.subarray(i, i + chunkSize));
  res.end();
}

const server = createServer((req, res) => {
  if (process.env.HEADER_LOG) appendFileSync(process.env.HEADER_LOG, `${req.headers.authorization ?? ''}\n`);
  if (req.method !== 'POST' || !req.url.startsWith(endpoint)) {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('method not allowed');
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${body}\n`);
    if (process.env.HTML_REPLY) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      return writeBody(res, Buffer.from('<!doctype html>\n<title>502 Bad Gateway</title>\n<h1>Bad Gateway</h1>\n', 'utf8'));
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }

    const frames = Array.isArray(msg) ? msg : [msg];
    const results = await Promise.all(frames.map((f) => handle(f, () => {})));
    if (results.includes(DIE)) return req.socket.destroy();
    if (results.includes(SILENT)) return;
    const responses = results.filter((r) => r !== undefined);

    // A batch of notifications warrants no body at all.
    if (responses.length === 0) {
      res.writeHead(202);
      return res.end();
    }
    if (process.env.SSE_REPLIES) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events = [': keepalive\r\n\r\n', ...responses.map((r) => `event: message\r\ndata: ${JSON.stringify(r)}\r\n\r\n`)];
      return writeBody(res, Buffer.from(events.join(''), 'utf8'), 7);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    writeBody(res, Buffer.from(JSON.stringify(Array.isArray(msg) ? responses : responses[0]), 'utf8'));
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`LISTENING http://127.0.0.1:${port}${endpoint}\n`);
});
