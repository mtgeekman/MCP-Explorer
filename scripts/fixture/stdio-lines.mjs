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

export function writer(stream) {
  const send = (m) => stream.write(JSON.stringify(m) + '\n');
  return {
    send,
    reply: (id, result) => send({ jsonrpc: '2.0', id, result }),
    fail: (id, code, message, data) =>
      send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }),
  };
}
