export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = boolean | { [key: string]: Json };
export interface ToolContract { name: string; inputSchema: Schema }
export interface Snapshot { format: 1; tools: ToolContract[] }
export interface Change { tool: string; path: string; severity: 'breaking' | 'review'; reason: string }
export interface Report { verdict: 'compatible' | 'breaking' | 'review'; changes: Change[]; addedTools: string[] }

const annotations = new Set(['description', 'title', 'examples', '$comment', 'default', 'deprecated']);
const types = ['null', 'boolean', 'object', 'array', 'number', 'integer', 'string'];
const lowerBounds = new Set(['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']);
const upperBounds = new Set(['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function validateSchema(value: unknown, depth = 0): asserts value is Schema {
  if (depth > 40) throw new Error('Schema nesting exceeds 40 levels');
  if (typeof value === 'boolean') return;
  if (!record(value)) throw new Error('Schema must be an object or boolean');
  if (Object.hasOwn(value, 'type')) {
    const declared = Array.isArray(value.type) ? value.type : [value.type];
    if (declared.length === 0 || declared.some((type) => typeof type !== 'string' || !types.includes(type))) {
      throw new Error('Invalid schema type');
    }
  }
  if (Object.hasOwn(value, 'required') &&
      (!Array.isArray(value.required) || value.required.some((name) => typeof name !== 'string'))) {
    throw new Error('Invalid required list');
  }
  if (Object.hasOwn(value, 'enum') && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    throw new Error('Invalid enum');
  }
  if (Object.hasOwn(value, 'properties')) {
    if (!record(value.properties)) throw new Error('Invalid schema properties');
    for (const child of Object.values(value.properties)) validateSchema(child, depth + 1);
  }
  for (const key of ['additionalProperties', 'items']) {
    if (Object.hasOwn(value, key)) validateSchema(value[key], depth + 1);
  }
  for (const key of [...lowerBounds, ...upperBounds]) {
    if (Object.hasOwn(value, key) && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) {
      throw new Error('Invalid schema bound');
    }
  }
}

export function parseSnapshot(value: unknown): Snapshot {
  if (!record(value) || value.format !== 1 || !Array.isArray(value.tools) || value.tools.length > 1000) {
    throw new Error('Expected snapshot format 1 with at most 1000 tools');
  }
  const names = new Set<string>();
  const tools: ToolContract[] = value.tools.map((tool: unknown) => {
    if (!record(tool) || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new Error('Invalid tool name');
    }
    if (names.has(tool.name)) throw new Error('Duplicate tool name');
    names.add(tool.name);
    validateSchema(tool.inputSchema);
    if (!record(tool.inputSchema) || tool.inputSchema.type !== 'object') {
      throw new Error('MCP tool inputs must declare type object');
    }
    return { name: tool.name, inputSchema: tool.inputSchema as Schema };
  });
  tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { format: 1, tools };
}

function pointer(path: string, key: string): string {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function schemaTypes(value: Json | undefined): string[] {
  return value === undefined ? types : (Array.isArray(value) ? value : [value]) as string[];
}

function compareSchema(old: Schema, next: Schema, tool: string, path: string, changes: Change[]): void {
  if (canonical(old) === canonical(next) || old === false || next === true) return;
  const add = (severity: Change['severity'], key: string, reason: string) => {
    changes.push({ tool, path: pointer(path, key), severity, reason });
  };
  if (next === false) { add('breaking', '', 'Previously accepted input may now be rejected'); return; }
  const before = old === true ? {} : old;
  const after = next;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const known = new Set([
    'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const',
    ...lowerBounds, ...upperBounds,
  ]);
  const meaningfulChange = [...keys].some((key) => !annotations.has(key) && canonical(before[key]) !== canonical(after[key]));
  if (meaningfulChange) {
    for (const key of keys) {
      if (annotations.has(key) || known.has(key)) continue;
      if (key === '$schema' && before[key] === 'https://json-schema.org/draft/2020-12/schema' && before[key] === after[key]) continue;
      if (canonical(before[key]) === canonical(after[key])) {
        add('review', key, 'Unsupported keyword may interact with other schema changes');
      }
    }
  }
  const oldTypes = schemaTypes(before.type);
  const newTypes = schemaTypes(after.type);
  if (!oldTypes.every((type) => newTypes.includes(type) || (type === 'integer' && newTypes.includes('number')))) {
    add('breaking', 'type', 'Accepted input types narrowed');
  }
  const oldRequired = new Set((before.required ?? []) as string[]);
  for (const name of (after.required ?? []) as string[]) {
    if (!oldRequired.has(name)) add('breaking', `required:${name}`, 'A new required property was introduced');
  }
  if (after.enum !== undefined) {
    const allowed = new Set((after.enum as Json[]).map(canonical));
    if (before.enum === undefined || !(before.enum as Json[]).every((item) => allowed.has(canonical(item)))) {
      add('breaking', 'enum', 'Accepted enum values narrowed');
    }
  }
  if (Object.hasOwn(after, 'const') && (!Object.hasOwn(before, 'const') || canonical(before.const) !== canonical(after.const))) {
    add('breaking', 'const', 'A constant restriction was introduced or changed');
  }
  const oldProperties = (before.properties ?? {}) as Record<string, Schema>;
  const newProperties = (after.properties ?? {}) as Record<string, Schema>;
  const oldExtra = (before.additionalProperties ?? true) as Schema;
  const newExtra = (after.additionalProperties ?? true) as Schema;
  compareExtra(oldExtra, newExtra);
  for (const key of new Set([...Object.keys(oldProperties), ...Object.keys(newProperties)])) {
    const oldProperty = Object.hasOwn(oldProperties, key) ? oldProperties[key]! : oldExtra;
    const newProperty = Object.hasOwn(newProperties, key) ? newProperties[key]! : newExtra;
    compareSchema(oldProperty, newProperty, tool, pointer(pointer(path, 'properties'), key), changes);
  }
  if (before.items !== undefined || after.items !== undefined) {
    compareSchema((before.items ?? true) as Schema, (after.items ?? true) as Schema, tool, pointer(path, 'items'), changes);
  }
  for (const key of keys) {
    if (annotations.has(key) || ['type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const'].includes(key)) continue;
    if (canonical(before[key]) === canonical(after[key])) continue;
    if (lowerBounds.has(key) || upperBounds.has(key)) {
      if (after[key] === undefined) continue;
      if (before[key] === undefined || (lowerBounds.has(key)
        ? (after[key] as number) > (before[key] as number)
        : (after[key] as number) < (before[key] as number))) {
        add('breaking', key, 'An input bound became more restrictive');
      }
    } else {
      add('review', key, 'Changed keyword requires manual review; compatibility was not proven');
    }
  }

  function compareExtra(previous: Schema, current: Schema): void {
    if (canonical(previous) === canonical(current) || previous === false || current === true) return;
    if (current === false) add('breaking', 'additionalProperties', 'Additional input properties are no longer accepted');
    else compareSchema(previous, current, tool, pointer(path, 'additionalProperties'), changes);
  }
}

export function compareSnapshots(previous: Snapshot, current: Snapshot): Report {
  const before = parseSnapshot(previous);
  const after = parseSnapshot(current);
  const next = new Map(after.tools.map((tool) => [tool.name, tool]));
  const changes: Change[] = [];
  for (const tool of before.tools) {
    const replacement = next.get(tool.name);
    if (!replacement) changes.push({ tool: tool.name, path: '', severity: 'breaking', reason: 'Tool was removed' });
    else compareSchema(tool.inputSchema, replacement.inputSchema, tool.name, '/inputSchema', changes);
  }
  const names = new Set(before.tools.map((tool) => tool.name));
  return {
    verdict: changes.some((change) => change.severity === 'breaking') ? 'breaking' : changes.length ? 'review' : 'compatible',
    changes,
    addedTools: after.tools.filter((tool) => !names.has(tool.name)).map((tool) => tool.name),
  };
}
