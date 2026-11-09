import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareSnapshots, parseSnapshot, type Schema, type Snapshot } from '../src/index.js';

function snapshot(schema: Schema, name = 'search'): Snapshot {
  return { format: 1, tools: [{ name, inputSchema: schema }] };
}
const original: Schema = {
  type: 'object', additionalProperties: false,
  properties: { query: { type: 'string', minLength: 2 }, limit: { type: 'integer', maximum: 10 } },
  required: ['query'],
};

test('new optional properties and widened bounds preserve a closed input contract', () => {
  const widened: Schema = {
    ...original,
    properties: {
      query: { type: 'string', minLength: 1, description: 'Changed annotation' },
      limit: { type: 'number', maximum: 20 },
      cursor: { type: 'string' },
    },
  };
  assert.equal(compareSnapshots(snapshot(original), snapshot(widened)).verdict, 'compatible');
});

test('tool removals, new required inputs, and narrowed bounds fail the gate', () => {
  assert.equal(compareSnapshots(snapshot(original), { format: 1, tools: [] }).verdict, 'breaking');
  const required = compareSnapshots(snapshot(original), snapshot({ ...original, required: ['query', 'limit'] }));
  assert.ok(required.changes.some((change) => change.reason.includes('required')));
  const changed: Schema = { ...original, properties: { query: { type: 'string', minLength: 3 } } };
  const report = compareSnapshots(snapshot(original), snapshot(changed));
  assert.equal(report.verdict, 'breaking');
  assert.ok(report.changes.some((change) => change.path.includes('limit')));
});

test('input enum widening is safe, narrowing is flagged, and integer is a subset of number', () => {
  const before = snapshot({ type: 'object', properties: { mode: { type: 'string', enum: ['a'] } } });
  const after = snapshot({ type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } });
  assert.equal(compareSnapshots(before, after).verdict, 'compatible');
  assert.equal(compareSnapshots(after, before).verdict, 'breaking');
  const typed = (type: string) => snapshot({ type: 'object', properties: { count: { type } } });
  assert.equal(compareSnapshots(typed('integer'), typed('number')).verdict, 'compatible');
  assert.equal(compareSnapshots(typed('number'), typed('integer')).verdict, 'breaking');
});

test('unknown changed constraints fail closed as review rather than silently passing', () => {
  const before = snapshot({ type: 'object', properties: { query: { type: 'string', pattern: '^a' } } });
  const after = snapshot({ type: 'object', properties: { query: { type: 'string', pattern: '^b' } } });
  assert.equal(compareSnapshots(before, after).verdict, 'review');
  assert.equal(compareSnapshots(before, before).verdict, 'compatible');
});

test('unchanged complex keywords cannot hide interactions with apparently additive changes', () => {
  const before = snapshot({
    type: 'object', unevaluatedProperties: false, properties: { query: { type: 'string' } },
  });
  const after = snapshot({ type: 'object', unevaluatedProperties: false, properties: {} });
  assert.equal(compareSnapshots(before, after).verdict, 'review');
});

test('property names matching annotation keywords are still checked', () => {
  const before = snapshot({ type: 'object', additionalProperties: false, properties: { description: { type: 'string' } } });
  const after = snapshot({ type: 'object', additionalProperties: false, properties: {} });
  assert.equal(compareSnapshots(before, after).verdict, 'breaking');
});

test('properties accepted as extras cannot silently acquire new restrictions', () => {
  const before = snapshot({ type: 'object' });
  const after = snapshot({ type: 'object', properties: { query: { type: 'string' } } });
  assert.equal(compareSnapshots(before, after).verdict, 'breaking');
});

test('nested arrays and objects are checked with escaped JSON-pointer locations', () => {
  const before = snapshot({ type: 'object', properties: { 'a/b~c': { type: 'array', items: { type: 'string' } } } });
  const after = snapshot({ type: 'object', properties: { 'a/b~c': { type: 'array', items: { type: 'integer' } } } });
  const report = compareSnapshots(before, after);
  assert.equal(report.verdict, 'breaking');
  assert.match(report.changes[0]!.path, /a~1b~0c/);
});

test('duplicate tools and malformed supported schema shapes are rejected', () => {
  const tool = { name: 'search', inputSchema: original };
  assert.throws(() => parseSnapshot({ format: 1, tools: [tool, tool] }), /Duplicate/);
  assert.throws(() => parseSnapshot(snapshot({ type: 'object', required: [1] })), /required/);
  assert.throws(() => parseSnapshot(snapshot({ type: 'object', properties: [] })), /properties/);
  assert.throws(() => parseSnapshot(snapshot(original, 'bad\nname')), /name/);
});

test('tool order and descriptions do not manufacture contract drift', () => {
  const before: Snapshot = { format: 1, tools: [{ name: 'z', inputSchema: original }, { name: 'a', inputSchema: original }] };
  const after: Snapshot = { format: 1, tools: [...before.tools].reverse() };
  assert.equal(compareSnapshots(before, after).verdict, 'compatible');
  const renamedDescription: Schema = { ...original, description: 'Different description' };
  assert.equal(compareSnapshots(snapshot(original), snapshot(renamedDescription)).verdict, 'compatible');
});
