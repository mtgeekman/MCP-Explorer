// The form engine against a corpus (D9; plan phase 07 acceptance): real tool
// schemas captured from two reference servers, plus the fixture's hostile
// ones. Every schema either renders a form that round-trips a valid value, or
// hands off to the JSON editor. Never a third outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAgainst } from '../packages/protocol/dist/index.js';
import { HOSTILE_SCHEMAS } from '../scripts/fixture/call-handler.mjs';
import {
  planForm, leaves, getAt, setAt, formatInput, parseInput, isInputError, editorText, parseEditor, sampleArgs,
} from '../app/renderer/src/lib/schemaForm.ts';

const real = ['server-everything', 'server-filesystem'].flatMap((name) => {
  const corpus = JSON.parse(readFileSync(new URL(`./corpus/${name}.json`, import.meta.url), 'utf8'));
  return corpus.tools.map((t) => ({ source: `${name}/${t.name}`, schema: t.inputSchema, real: true }));
});
const hostile = Object.entries(HOSTILE_SCHEMAS).map(([name, schema]) => ({ source: `fixture/${name}`, schema, real: false }));
const corpus = [...real, ...hostile];

test('the corpus holds real schemas and hostile ones', () => {
  assert.equal(real.length, 30);
  assert.ok(hostile.length >= 15);
});

for (const { source, schema } of corpus) {
  test(`${source}: a form that round-trips a valid value, or the editor`, async () => {
    const plan = planForm(schema);
    if (plan.kind === 'editor-only') {
      assert.ok(plan.reason.length > 0, 'the hand-off says why');
      return;
    }
    const sample = sampleArgs(plan.fields);
    if (sample === undefined) {
      // A required value the form cannot produce is the editor's, and says so.
      const handedOff = leaves(plan.fields).filter((f) => f.kind === 'editor' && f.required);
      assert.ok(handedOff.length > 0, 'the form could not fill a required field and handed nothing to the editor');
      return;
    }
    const verdict = await validateAgainst(schema, sample);
    assert.deepEqual(verdict, { valid: true }, `the form's value is invalid: ${JSON.stringify(sample)}`);

    // Form to value and back: every field shows its value and reads it back unchanged.
    let rebuilt = {};
    for (const f of leaves(plan.fields)) {
      if (f.kind === 'editor') continue;
      const v = getAt(sample, f.path);
      const text = formatInput(f, v);
      assert.notEqual(text, null, `${f.path.join('.')} cannot show its own value`);
      const back = parseInput(f, text);
      assert.ok(!isInputError(back), `${f.path.join('.')}: ${back?.error}`);
      assert.deepEqual(back, v);
      if (back !== undefined) rebuilt = setAt(rebuilt, f.path, back);
    }
    assert.deepEqual(rebuilt, sample, 'the fields rebuild the value');

    // The editor holds the same value: its text parses back to exactly it.
    const parsed = parseEditor(editorText(sample));
    assert.deepEqual(parsed.args, sample);
  });
}

test('the fallback rate on real schemas is the number to watch: every one renders as a form', () => {
  const plans = real.map(({ source, schema }) => ({ source, plan: planForm(schema) }));
  const editorOnly = plans.filter((p) => p.plan.kind === 'editor-only').map((p) => p.source);
  const withHandOff = plans.filter((p) => p.plan.kind === 'form' && leaves(p.plan.fields).some((f) => f.kind === 'editor')).map((p) => p.source);
  assert.deepEqual(editorOnly, [], 'a real schema went to the editor whole');
  // Recorded, not a target: fields the form hands to the editor in real schemas.
  process.stdout.write(`# real schemas: ${plans.length}, editor-only: ${editorOnly.length}, with an editor field: ${withHandOff.length} (${withHandOff.join(', ')})\n`);
});

test('the hostile schemas land where D9 says', () => {
  const kind = (name) => planForm(HOSTILE_SCHEMAS[name]);
  const fieldKind = (name, key) => kind(name).fields.find((f) => f.label === key)?.kind;
  for (const name of ['schema_not_object', 'schema_no_type', 'schema_pattern_props']) assert.equal(kind(name).kind, 'editor-only', name);
  assert.equal(fieldKind('schema_oneof', 'target'), 'editor');
  assert.equal(fieldKind('schema_anyof_nullable', 'note'), 'editor');
  assert.equal(fieldKind('schema_type_array', 'note'), 'editor');
  assert.equal(fieldKind('schema_allof', 'thing'), 'editor');
  assert.equal(fieldKind('schema_ref', 'at'), 'editor');
  assert.equal(fieldKind('schema_array_objects', 'rows'), 'editor');
  assert.equal(fieldKind('schema_array_strings', 'tags'), 'array');
  assert.equal(fieldKind('schema_const', 'version'), 'const');
  assert.equal(fieldKind('schema_nested', 'outer'), 'object');
  assert.deepEqual(kind('schema_additional'), { kind: 'form', fields: [], open: true });
  assert.deepEqual(kind('schema_empty'), { kind: 'form', fields: [], open: true });
  assert.equal(kind('schema_primitives').fields.find((f) => f.label === 'colour').kind, 'enum');
});

test('deep nesting past the limit hands the inner object to the editor', () => {
  const deep = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'string' } } } } } } } } };
  const a = planForm(deep).fields[0];
  assert.equal(a.kind, 'object');
  const b = a.fields[0];
  assert.equal(b.kind, 'object');
  assert.equal(b.fields[0].kind, 'editor');
  assert.match(b.fields[0].reason, /deeper/);
});

test('inputs: empty is absent, not "", and text that is not the type is an error, never a coercion', () => {
  const plan = planForm(HOSTILE_SCHEMAS.schema_primitives);
  const f = (label) => plan.fields.find((x) => x.label === label);
  assert.equal(parseInput(f('text'), ''), undefined);
  assert.deepEqual(parseInput(f('count'), '2.5'), { error: '2.5 is not a whole number' });
  assert.deepEqual(parseInput(f('ratio'), 'abc'), { error: 'abc is not a number' });
  assert.equal(parseInput(f('ratio'), '0.25'), 0.25);
  assert.equal(formatInput(f('count'), 'seven'), null, 'a value the input cannot show goes to the editor');
  assert.deepEqual(setAt({ outer: { inner: { leaf: 'x' } } }, ['outer', 'inner', 'leaf'], undefined), {}, 'clearing a nested field leaves no empty objects');
  assert.deepEqual(parseEditor('[1]'), { error: 'Arguments are a JSON object.' });
});
