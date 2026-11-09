import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run using npm run smoke:package');
const directory = mkdtempSync(join(tmpdir(), 'mcp-contract-consumer-'));
const runNpm = (args, cwd = root) => execFileSync(process.execPath, [npm, ...args], {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});
try {
  const packed = JSON.parse(runNpm(['pack', '--json', '--pack-destination', directory]))[0];
  assert.ok(packed.files.every(({ path }) => /^(dist\/src\/|README\.md$|LICENSE$|package\.json$)/.test(path)));
  const consumer = join(directory, 'consumer');
  runNpm(['install', '--prefix', consumer, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', join(directory, packed.filename)]);
  const installed = join(consumer, 'node_modules', '@kimj0107', 'mcp-contract-check');
  const cli = join(installed, 'dist', 'src', 'cli.js');
  assert.ok(existsSync(join(installed, 'dist', 'src', 'index.d.ts')));
  const bin = join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'mcp-contract-check.cmd' : 'mcp-contract-check');
  assert.ok(existsSync(bin), 'npm must install the CLI binary link');
  const baseline = join(directory, 'contract.json');
  const fixture = join(root, 'dist', 'test', 'fixtures', 'server.js');
  const run = (args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20_000 });
  assert.match(run(['--help']), /snapshot/);
  run(['snapshot', '--out', baseline, '--', process.execPath, fixture]);
  assert.equal(JSON.parse(run(['check', '--baseline', baseline, '--', process.execPath, fixture])).verdict, 'compatible');
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'import {compareSnapshots} from "@kimj0107/mcp-contract-check"; if(compareSnapshots({format:1,tools:[]},{format:1,tools:[]}).verdict!=="compatible")process.exit(1);',
  ], { cwd: consumer, timeout: 20_000 });
  console.log('Clean packed consumer: CLI, declarations, library export, live capture, and check passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
