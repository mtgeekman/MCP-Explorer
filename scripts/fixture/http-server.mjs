// Streamable HTTP fixture, serving the SAME handler as the stdio server.
//
// Prints its listening URL on stdout as `LISTENING <url>` so a test can start
// it without guessing a port.
//
// Modes, for the wire log's byte-exact tests (D34, D35):
//   SSE_CUT      answer a tools/call with an event stream, then drop the
//                connection halfway through the event, as a crashing server does
//   SSE_REPLIES  answer each POST with an event stream instead of a JSON body:
//                a comment, then the response as one event with CRLF line
//                endings, written a few bytes at a time.
//   HTML_REPLY   answer every POST with a 502 HTML page, as a proxy in front
//                of a dead server would.
//   WIRE_LOG     append every response body written, as hex, one per line.
//   HEADER_LOG   append the Authorization header each request carried.
//   MCP_HEADER_LOG  append each POST's Mcp-* headers as one JSON line (phase 10).
//   SSE_PRIMED_CUT  a tools/call's stream sends an event id, then closes; the
//                response comes when the client resumes with Last-Event-ID.
//   LEGACY       serve the legacy-era handler instead of the modern one; its
//                hostile modes die by dropping the connection, or hang.
//   STREAMING    (phase 10) answer every POST that carries a request with an
//                event stream: whatever the handler sends first (progress, log
//                messages, a legacy server's own requests, a listen's
//                acknowledgement and notices) as events, then the response.
//                A request the handler never answers (a listen) keeps its
//                stream open; the client closing it is its cancellation. On
//                LEGACY a GET opens the stream for notices sent outside any
//                request. The client's answer to a server request arrives as a
//                POST of its own and is answered 202.
//   AUTH         (phase 11) serve the fixture authorization server from this
//                process and require its bearer tokens on the MCP endpoint;
//                its own modes are in auth-server.mjs.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { DIE, SILENT } from './legacy-handler.mjs';
import { eraAnswerer } from './answer.mjs';
import { setBroadcast } from './extras.mjs';
import { handleAuth, checkBearer } from './auth-server.mjs';

// CALL_TOOLS calls are answered here too; a progress notification is dropped,
// since a JSON body carries one message. Progress is exercised over stdio.
const handle = eraAnswerer(process.env.LEGACY ? 'legacy' : 'modern');

const endpoint = '/mcp';

function writeBody(res, bytes, chunkSize) {
  if (process.env.WIRE_LOG) appendFileSync(process.env.WIRE_LOG, `${bytes.toString('hex')}\n`);
  if (!chunkSize) return res.end(bytes);
  for (let i = 0; i < bytes.length; i += chunkSize) res.write(bytes.subarray(i, i + chunkSize));
  res.end();
}

const event = (m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`;

/** STREAMING, LEGACY: the GET stream, where notices sent outside any request go. */
function openGetStream(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(': open\n\n');
  setBroadcast((m) => res.write(event(m)));
}

/** STREAMING: one POST's request answered on its own event stream. */
async function stream(req, res, frame) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let done = false;
  res.on('close', () => {
    // The client closed the stream before the response: on Streamable HTTP
    // that is how a request is cancelled.
    if (!done) void handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: frame.id, reason: 'stream closed' } }, () => {});
  });
  const response = await handle(frame, (m) => { if (!res.writableEnded) res.write(event(m)); });
  done = true;
  if (response === DIE) return req.socket.destroy();
  if (response === SILENT || res.writableEnded) return;
  if (response !== undefined) res.write(event(response));
  res.end();
}

/**
 * SSE_PRIMED_CUT: a tools/call's stream carries one event with an id and no
 * data, then closes without the response (the 2025-11-25 polling pattern).
 * The response waits for the client to resume with Last-Event-ID on a GET.
 * RESUME_REFUSED: the resume GET is answered 405, so the response never comes.
 * SSE_ID_ONLY_CUT: the event carries an id and no data line, which the SSE
 * parser never dispatches, so there is nothing to resume from.
 */
const resumable = new Map();

async function primedCut(res, frame) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(process.env.SSE_ID_ONLY_CUT ? 'id: only-1\n\n' : 'id: primed-1\nretry: 50\ndata:\n\n');
  res.end();
  const response = await handle(frame, () => {});
  if (!process.env.RESUME_REFUSED && !process.env.SSE_ID_ONLY_CUT) resumable.set('primed-1', response);
}

function resume(req, res) {
  const response = resumable.get(req.headers['last-event-id']);
  resumable.delete(req.headers['last-event-id']);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(`id: primed-2\nevent: message\ndata: ${JSON.stringify(response)}\n\n`);
}

let origin = '';

const server = createServer(async (req, res) => {
  if (process.env.HEADER_LOG) appendFileSync(process.env.HEADER_LOG, `${req.headers.authorization ?? ''}\n`);
  if (process.env.AUTH) {
    if (await handleAuth(req, res, origin, endpoint)) return;
    // Every MCP request needs a token. A POST's frames are read first, below,
    // so that a tool needing more scope can be told apart.
    if (req.url.startsWith(endpoint) && req.method !== 'POST' && !checkBearer(req, res, origin, endpoint)) return;
  }
  if (req.method === 'GET' && req.headers['last-event-id'] && resumable.has(req.headers['last-event-id'])) return resume(req, res);
  if (process.env.STREAMING && process.env.LEGACY && req.method === 'GET' && req.url.startsWith(endpoint)) return openGetStream(res);
  if (req.method !== 'POST' || !req.url.startsWith(endpoint)) {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('method not allowed');
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${body}\n`);
    if (process.env.MCP_HEADER_LOG) {
      const mcp = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith('mcp-')));
      appendFileSync(process.env.MCP_HEADER_LOG, `${JSON.stringify(mcp)}\n`);
    }
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
    if (process.env.AUTH && !checkBearer(req, res, origin, endpoint, frames)) return;
    if ((process.env.SSE_PRIMED_CUT || process.env.SSE_ID_ONLY_CUT) && !Array.isArray(msg) && msg.method === 'tools/call') return primedCut(res, msg);
    if (process.env.STREAMING && !Array.isArray(msg) && msg.method !== undefined && msg.id !== undefined) return stream(req, res, msg);
    const results = await Promise.all(frames.map((f) => handle(f, () => {})));
    if (results.includes(DIE)) return req.socket.destroy();
    if (results.includes(SILENT)) return;
    const responses = results.filter((r) => r !== undefined);

    // A batch of notifications warrants no body at all.
    if (responses.length === 0) {
      res.writeHead(202);
      return res.end();
    }
    if (process.env.SSE_CUT && frames.some((f) => f.method === 'tools/call')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: message\ndata: {"jsonrpc":"2.0"');
      return setTimeout(() => req.socket.destroy(), 50);
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
  origin = `http://127.0.0.1:${port}`;
  process.stdout.write(`LISTENING http://127.0.0.1:${port}${endpoint}\n`);
});
