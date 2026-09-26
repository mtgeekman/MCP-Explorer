// The readable pane's JSON: formatting by mode and the tokenizer that colors
// it. Imported as TypeScript; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, reformatJson, tokenizeJson } from '../app/renderer/src/lib/json.ts';

test('pretty indents by two, compact is one line, undefined is shown as the word', () => {
  const v = { a: [1, { b: null }], c: 'x' };
  assert.equal(formatJson(v, 'pretty'), '{\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "c": "x"\n}');
  assert.equal(formatJson(v, 'compact'), '{"a":[1,{"b":null}],"c":"x"}');
  assert.equal(formatJson(undefined, 'pretty'), 'undefined');
});

test('text that is already JSON is reformatted; text that is not is left as it was', () => {
  assert.equal(reformatJson('{\n  "a": 1\n}', 'compact'), '{"a":1}');
  assert.equal(reformatJson('{"a":1}', 'pretty'), '{\n  "a": 1\n}');
  assert.equal(reformatJson('not json {', 'compact'), 'not json {');
});

test('tokens: keys apart from string values, numbers, literals, punctuation, and every character kept in order', () => {
  const text = '{\n  "name": "echo",\n  "n": -1.5e3,\n  "ok": true,\n  "none": null,\n  "list": ["a", 2]\n}';
  const tokens = tokenizeJson(text);
  assert.equal(tokens.map((t) => t.text).join(''), text, 'nothing lost or reordered');
  const kinds = (k) => tokens.filter((t) => t.kind === k).map((t) => t.text);
  assert.deepEqual(kinds('key'), ['"name"', '"n"', '"ok"', '"none"', '"list"']);
  assert.deepEqual(kinds('string'), ['"echo"', '"a"']);
  assert.deepEqual(kinds('number'), ['-1.5e3', '2']);
  assert.deepEqual(kinds('literal'), ['true', 'null']);
  assert.ok(kinds('punct').includes(':') && kinds('punct').includes('['));
});

test('tokens: escaped quotes stay inside their string, and a key is found across spaces before its colon', () => {
  const tokens = tokenizeJson('{"a\\"b" :"c\\\\"}');
  assert.deepEqual(tokens.filter((t) => t.kind === 'key').map((t) => t.text), ['"a\\"b"']);
  assert.deepEqual(tokens.filter((t) => t.kind === 'string').map((t) => t.text), ['"c\\\\"']);
});

test('tokens: text that is not JSON still comes back whole, the unknown runs as other', () => {
  const text = 'undefined';
  const tokens = tokenizeJson(text);
  assert.equal(tokens.map((t) => t.text).join(''), text);
  assert.ok(tokens.some((t) => t.kind === 'other'));
});

test('prettyTokens without decoding is exactly JSON.stringify(value, null, 2)', async () => {
  const { prettyTokens } = await import('../app/renderer/src/lib/json.ts');
  const samples = [
    {}, [], null, true, 0, -1.5e-7, 'a "quoted" \ string\nwith lines', [1, [2, [3, {}]], []],
    { a: undefined, b: () => 1, c: [undefined, () => 1], d: { e: NaN, f: Infinity }, g: new Date(0), 'weird key': ' ' },
    { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '[{"page":"x"}]' }], isError: false } },
  ];
  for (const v of samples) {
    const text = prettyTokens(v, { embedded: false }).map((t) => t.text).join('');
    assert.equal(text, JSON.stringify(v, null, 2), JSON.stringify(v));
  }
});

test('in Pretty, a string holding a JSON object or array is decoded between markers with a badge; anything else stays a string', async () => {
  const { prettyTokens, embeddedJson, EMBED_DEPTH } = await import('../app/renderer/src/lib/json.ts');
  assert.deepEqual(embeddedJson(' [{"a":1}]'), [{ a: 1 }]);
  assert.equal(embeddedJson('42'), undefined, 'a number in a string stays a string');
  assert.equal(embeddedJson('"x"'), undefined);
  assert.equal(embeddedJson('{not json'), undefined);
  assert.equal(embeddedJson('null'), undefined);

  const tokens = prettyTokens({ text: '[{"page":"claude/x","score":0.4}]' }, { embedded: true });
  const kinds = tokens.map((t) => t.kind);
  assert.equal(kinds.filter((k) => k === 'embed-open').length, 1);
  assert.equal(tokens.find((t) => t.kind === 'badge').text, 'JSON in a string');
  assert.deepEqual(tokens.filter((t) => t.kind === 'key').map((t) => t.text), ['"text"', '"page"', '"score"'], 'the decoded keys are keys');
  const shown = tokens.filter((t) => t.kind !== 'badge').map((t) => t.text).join('');
  assert.equal(shown, '{\n  "text": [\n    {\n      "page": "claude/x",\n      "score": 0.4\n    }\n  ]\n}', 'laid out at the depth where the string was');

  // Nesting stops at EMBED_DEPTH: past it, the string is shown as a string.
  let v = { deepest: 1 };
  for (let i = 0; i < EMBED_DEPTH + 1; i++) v = { s: JSON.stringify(v) };
  const deep = prettyTokens(v, { embedded: true });
  assert.equal(deep.filter((t) => t.kind === 'embed-open').length, EMBED_DEPTH);
  assert.ok(deep.some((t) => t.kind === 'string' && t.text.includes('deepest')), 'the innermost stays a string');
});
