// HTTP+SSE fixture -- the transport deprecated in 2025-03-26 and still live on
// real servers, which is why P3 requires the app speak it.
//
// Serves the SAME handler as the stdio and Streamable HTTP fixtures. Transport
// and protocol revision are orthogonal, and serving one surface over all three
// is what makes "identical capture across transports" a real assertion rather
// than three copies agreeing with each other.
//
// Shape: GET /sse opens the event stream and immediately announces the POST
// endpoint; the client POSTs there and every response comes back over the
// stream, not in the POST body.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { handleModern } from './modern-handler.mjs';

const streams = new Map();

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = randomUUID();
    streams.set(sessionId, res);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    req.on('close', () => streams.delete(sessionId));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    const stream = streams.get(url.searchParams.get('sessionId'));
    if (!stream) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('no such session');
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
        res.writeHead(400);
        return res.end();
      }
      // The POST is only an acknowledgement; the answer travels on the stream.
      res.writeHead(202);
      res.end();
      for (const frame of Array.isArray(msg) ? msg : [msg]) {
        const response = handleModern(frame);
        if (response !== undefined) stream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING http://127.0.0.1:${server.address().port}/sse\n`);
});
