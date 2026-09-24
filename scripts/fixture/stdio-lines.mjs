import { appendFileSync } from 'node:fs';

// Shared newline-delimited JSON reader for the fixture servers.
//
// Extracted so a second server cannot reintroduce the chunk-decoding bug fixed
// in 41e7b86: `buf += chunk` coerces each Buffer independently, so a multi-byte
// character split across a chunk boundary becomes replacement characters and
// the frame is silently dropped. setEncoding decodes the stream instead.
export function readFrames(stream, onFrame, { onUnparseable } = {}) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        // Never drop a frame silently: an invisible drop is what hid the
        // decoding bug, because the client just waits forever.
        (onUnparseable ?? ((l, e) => process.stderr.write(`fixture: unparseable frame (${e.message}): ${l}\n`)))(line, err);
        continue;
      }
      onFrame(msg, line);
    }
  });
}

/**
 * ODD_BYTES: write each frame the way a sloppy server might -- spaces inside
 * and around it, a CRLF ending, and in two writes -- so a client that logs a
 * re-serialization instead of the bytes it received cannot pass. The message
 * itself is unchanged: the SDK rejects an envelope with an extra key. WIRE_LOG: append every byte written to stdout to
 * that file, so a test can compare what the client logged with what was sent.
 */
export function writer(stream) {
  const odd = Boolean(process.env.ODD_BYTES);
  const write = (bytes) => {
    if (process.env.WIRE_LOG) appendFileSync(process.env.WIRE_LOG, bytes);
    stream.write(bytes);
  };
  const send = (m) => {
    if (!odd) return write(Buffer.from(JSON.stringify(m) + '\n', 'utf8'));
    // Indented JSON with its newlines removed: a newline inside a JSON string
    // is always escaped, so every raw newline here is formatting.
    const bytes = Buffer.from(` ${JSON.stringify(m, null, 1).replace(/\n/g, '')}  \r\n`, 'utf8');
    const split = Math.floor(bytes.length / 2);
    write(bytes.subarray(0, split));
    write(bytes.subarray(split));
  };
  return {
    send,
    reply: (id, result) => send({ jsonrpc: '2.0', id, result }),
    fail: (id, code, message, data) =>
      send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }),
  };
}
