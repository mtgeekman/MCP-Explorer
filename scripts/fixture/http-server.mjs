// Streamable HTTP fixture, serving the SAME handler as the stdio server.
//
// Prints its listening URL on stdout as `LISTENING <url>` so a test can start
// it without guessing a port.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { handleModern } from './modern-handler.mjs';

const endpoint = '/mcp';

const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith(endpoint)) {
    res.writeHead(405, { 'content-type': 'text/plain' });
    return res.end('method not allowed');
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${body}\n`);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    }

    const frames = Array.isArray(msg) ? msg : [msg];
    const responses = frames.map(handleModern).filter((r) => r !== undefined);

    // A batch of notifications warrants no body at all.
    if (responses.length === 0) {
      res.writeHead(202);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(msg) ? responses : responses[0]));
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`LISTENING http://127.0.0.1:${port}${endpoint}\n`);
});
