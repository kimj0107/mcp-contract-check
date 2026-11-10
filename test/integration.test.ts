import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { captureTools } from '../src/index.js';

const server = fileURLToPath(new URL('./fixtures/server.js', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, stdout, stderr });
    });
  });
}
async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-contract-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('real SDK initialization captures and sorts paginated stdio tools', { timeout: 10_000 }, async () => {
  const result = await captureTools({ command: process.execPath, args: [server, 'paginate'] });
  assert.deepEqual(result.tools.map((tool) => tool.name), ['fetch', 'search']);
});

test('explicit modern protocol adds the required envelope and auto can fall back to legacy', { timeout: 15_000 }, async () => {
  const modern = await captureTools({ command: process.execPath, args: [server, 'modern'], protocol: '2026-07-28' });
  assert.equal(modern.tools.length, 2);
  const legacy = await captureTools({ command: process.execPath, args: [server], protocol: 'auto' });
  assert.equal(legacy.tools.length, 2);
});

test('request deadline reaps a hanging server instead of leaking a process', { timeout: 10_000 }, async (t) => {
  const directory = await temporary(t);
  const marker = join(directory, 'pid');
  await assert.rejects(captureTools({
    command: process.execPath, args: [server, 'hang', marker], timeoutMs: 1000,
  }), /deadline/);
  const pid = Number((await readFile(marker, 'utf8')).trim());
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('non-converging pagination is rejected, not accepted as a partial baseline', { timeout: 10_000 }, async () => {
  await assert.rejects(captureTools({ command: process.execPath, args: [server, 'loop'] }), /capture failed/);
  await assert.rejects(captureTools({ command: process.execPath, args: [server, 'repeat-cursor'] }), /capture failed/);
});

test('CLI round trip gates a removed tool with machine-readable output', { timeout: 15_000 }, async (t) => {
  const directory = await temporary(t);
  const baseline = join(directory, 'baseline.json');
  assert.equal((await run(['snapshot', '--out', baseline, '--', process.execPath, server])).code, 0);
  assert.equal((await run(['check', '--baseline', baseline, '--', process.execPath, server])).code, 0);
  const changed = await run(['check', '--baseline', baseline, '--', process.execPath, server, 'breaking']);
  assert.equal(changed.code, 1, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).changes[0].reason, 'Tool was removed');
});

test('failed capture preserves an existing baseline even with explicit force', { timeout: 10_000 }, async (t) => {
  const directory = await temporary(t);
  const baseline = join(directory, 'baseline.json');
  const previous = '{"format":1,"tools":[]}\n';
  await writeFile(baseline, previous);
  const result = await run(['snapshot', '--out', baseline, '--force', '--', process.execPath, server, 'error']);
  assert.equal(result.code, 2);
  assert.equal(await readFile(baseline, 'utf8'), previous);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-sensitive/);
  assert.deepEqual(await readdir(directory), ['baseline.json']);
});

test('existing baseline is never overwritten implicitly or passed to a shell', { timeout: 10_000 }, async (t) => {
  const directory = await temporary(t);
  const baseline = join(directory, 'baseline.json');
  const marker = join(directory, 'should-not-start');
  await writeFile(baseline, '{"format":1,"tools":[]}');
  const result = await run(['snapshot', '--out', baseline, '--', process.execPath, server, 'normal', marker]);
  assert.equal(result.code, 2);
  assert.deepEqual(await readdir(directory), ['baseline.json']);
});

test('offline diff fails closed on unknown schema changes and invalid snapshots', { timeout: 10_000 }, async (t) => {
  const directory = await temporary(t);
  const before = join(directory, 'before.json');
  const after = join(directory, 'after.json');
  const value = (pattern: string) => JSON.stringify({
    format: 1, tools: [{ name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string', pattern } } } }],
  });
  await writeFile(before, value('a'));
  await writeFile(after, value('b'));
  assert.equal((await run(['diff', before, after])).code, 3);
  await writeFile(after, '{invalid');
  assert.equal((await run(['diff', before, after])).code, 2);
});

test('live check reports preserve JSON and gate codes without leaking schemas or server errors', { timeout: 15_000 }, async (t) => {
  const directory = await temporary(t);
  const baseline = join(directory, 'baseline.json');
  const junit = join(directory, 'check.xml');
  assert.equal((await run(['snapshot', '--out', baseline, '--', process.execPath, server])).code, 0);
  const args = ['check', '--baseline', baseline];
  const child = ['--', process.execPath, server, 'breaking'];
  const plain = await run([...args, ...child]);
  const reported = await run([...args, '--junit', junit, '--github-actions', ...child]);
  assert.equal(reported.code, plain.code);
  assert.equal(reported.stdout, plain.stdout);
  assert.equal(reported.stderr, '::error title=MCP contract breaking%3A fetch::Tool was removed\n');
  assert.match(await readFile(junit, 'utf8'), /failures="1"/);

  const failedReport = join(directory, 'failed.xml');
  const failure = await run([...args, '--junit', failedReport, '--github-actions', '--', process.execPath, server, 'error']);
  assert.equal(failure.code, 2);
  assert.equal(failure.stdout, '');
  assert.doesNotMatch(failure.stderr, /fixture-sensitive|::error/);
  assert.ok(!(await readdir(directory)).includes('failed.xml'));
});

test('offline reports preserve all verdicts and omit schema-derived paths and values', { timeout: 15_000 }, async (t) => {
  const directory = await temporary(t);
  const before = join(directory, 'before.json');
  const after = join(directory, 'after.json');
  const secret = 'schema-secret<&"%\r\n::error::injected';
  const snapshot = (schema: object) => JSON.stringify({
    format: 1, tools: [{ name: 'search', inputSchema: { type: 'object', ...schema } }],
  });
  await writeFile(before, snapshot({}));
  const cases = [
    { code: 0, schema: { description: secret }, findings: 0 },
    { code: 1, schema: { required: [secret], properties: { [secret]: { const: secret } } }, findings: 2 },
    { code: 3, schema: { [secret]: secret }, findings: 1 },
  ];
  for (const entry of cases) {
    await writeFile(after, snapshot(entry.schema));
    const junit = join(directory, `${entry.code}.xml`);
    const plain = await run(['diff', before, after]);
    const reported = await run(['diff', before, after, '--junit', junit, '--github-actions']);
    assert.equal(reported.code, entry.code, reported.stderr);
    assert.equal(reported.stdout, plain.stdout);
    const xml = await readFile(junit, 'utf8');
    assert.match(xml, new RegExp(`failures="${entry.findings}"`));
    assert.doesNotMatch(xml + reported.stderr, /schema-secret|inputSchema|injected/);
    assert.equal(reported.stderr.split('\n').filter(Boolean).length, entry.findings);
    if (entry.code === 3) assert.match(reported.stderr, /^::warning /);
  }
});

test('report errors fail explicitly and cannot overwrite inputs or existing report files', { timeout: 15_000 }, async (t) => {
  const directory = await temporary(t);
  const baseline = join(directory, 'baseline.json');
  const contents = '{"format":1,"tools":[]}';
  await writeFile(baseline, contents);
  for (const flags of [
    ['--junit', baseline],
    ['--junit', join(directory, 'missing', 'report.xml')],
    ['--junit'],
    ['--junit', '--github-actions'],
    ['--github-actions', '--github-actions'],
    ['--junit', 'first.xml', '--junit', 'second.xml'],
  ]) {
    const result = await run(['diff', baseline, baseline, ...flags]);
    assert.equal(result.code, 2, JSON.stringify(flags));
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error);
    assert.equal(await readFile(baseline, 'utf8'), contents);
  }
  const result = await run(['snapshot', '--out', join(directory, 'new.json'), '--github-actions', '--', process.execPath, server]);
  assert.equal(result.code, 2);
  assert.deepEqual(await readdir(directory), ['baseline.json']);
});
