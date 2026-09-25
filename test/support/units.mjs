// Wire units for storage tests (D34): a JSON-RPC message as the bytes of one
// stdio line. Real units come from the transport tap; these stand in for it
// where a test needs a recorder and no server.

/** One message, or a batch, as a `wire` unit: its JSON text and a newline. */
export const wire = (direction, message, eol = '\n') => ({ direction, kind: 'wire', bytes: Buffer.from(JSON.stringify(message) + eol, 'utf8') });

/** Records a message on a recorder as a one-message wire unit. */
export const frame = (rec, direction, message) => rec.unit(wire(direction, message));
