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
