import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'mcp-contract-ci-'));
const snapshot = (inputSchema) => JSON.stringify({
  format: 1, tools: [{ name: 'search', inputSchema }],
});
try {
  const baseline = join(directory, 'baseline.json');
  const current = join(directory, 'current.json');
  await writeFile(baseline, snapshot({ type: 'object' }));
  for (const [label, expected, schema, annotation] of [
    ['compatible', 0, { type: 'object' }, ''],
    ['breaking', 1, { type: 'object', required: ['query'] }, '::error '],
    ['review', 3, { type: 'object', pattern: 'sensitive-schema-value' }, '::warning '],
  ]) {
    await writeFile(current, snapshot(schema));
    const junit = join(directory, `${label}.xml`);
    const invoke = (flags) => {
      const result = spawnSync(process.execPath, [cli, 'diff', baseline, current, ...flags], {
        encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    };
    const plain = invoke([]);
    const reported = invoke(['--junit', junit, '--github-actions']);
    assert.equal(plain.status, expected);
    assert.equal(reported.status, expected);
    assert.equal(reported.stdout, plain.stdout);
    assert.equal(JSON.parse(reported.stdout).verdict, label);
    assert.ok(reported.stderr.startsWith(annotation));
    if (!annotation) assert.equal(reported.stderr, '');
    const xml = await readFile(junit, 'utf8');
    assert.match(xml, new RegExp(`failures="${expected === 0 ? 0 : 1}"`));
    assert.doesNotMatch(xml + reported.stderr, /sensitive-schema-value|inputSchema/);
  }
  console.log('CI example verified: compatible=0, breaking=1, review=3; JSON unchanged and reports redacted.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
