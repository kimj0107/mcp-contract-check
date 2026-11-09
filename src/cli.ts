#!/usr/bin/env node
import { link, lstat, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { captureTools, type CaptureOptions } from './capture.js';
import { canonical, compareSnapshots, parseSnapshot, type Snapshot } from './contract.js';

const help = `mcp-contract-check: snapshot MCP tool inputs and detect contract drift

  mcp-contract-check snapshot --out contract.json [options] -- executable args...
  mcp-contract-check check --baseline contract.json [options] -- executable args...
  mcp-contract-check diff before.json after.json

Options: --timeout <1..120000 ms>  --protocol legacy|auto|2026-07-28
         --force (snapshot only: explicitly replace an existing baseline)

Exit codes: 0 compatible/snapshot saved; 1 potentially breaking;
            2 usage, transport, or invalid snapshot; 3 manual review required.
Only trusted local executables should be launched. No tool is invoked.
Legacy negotiation is the default; modern negotiation is explicit.
`;

async function load(path: string): Promise<Snapshot> {
  if ((await stat(path)).size > 4_194_304) throw new Error('Snapshot exceeds 4 MiB');
  try { return parseSnapshot(JSON.parse(await readFile(path, 'utf8'))); }
  catch { throw new Error('Invalid contract snapshot'); }
}

async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args[0] === '--help') { process.stdout.write(help); return 0; }
  const command = args.shift();
  if (command === 'diff') {
    if (args.length !== 2) throw new Error('diff requires two snapshot paths');
    return report(compareSnapshots(await load(args[0]!), await load(args[1]!)));
  }
  if (command !== 'snapshot' && command !== 'check') throw new Error('Unknown command; use --help');
  const separator = args.indexOf('--');
  if (separator < 0 || !args[separator + 1]) throw new Error('Supply a trusted executable after --');
  const flags = args.slice(0, separator);
  const executable = args[separator + 1]!;
  const childArgs = args.slice(separator + 2);
  let target: string | undefined;
  let force = false;
  let timeoutMs = 10_000;
  let protocol: NonNullable<CaptureOptions['protocol']> = 'legacy';
  const seen = new Set<string>();
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (seen.has(flag)) throw new Error('Duplicate option');
    seen.add(flag);
    if (flag === '--force' && command === 'snapshot') { force = true; continue; }
    const value = flags[++index];
    if (!value) throw new Error('Missing option value');
    if (flag === (command === 'snapshot' ? '--out' : '--baseline')) target = value;
    else if (flag === '--timeout' && /^\d+$/.test(value)) timeoutMs = Number(value);
    else if (flag === '--protocol' && ['legacy', 'auto', '2026-07-28'].includes(value)) protocol = value as NonNullable<CaptureOptions['protocol']>;
    else throw new Error('Unknown option or invalid value; use --help');
  }
  if (!target) throw new Error(command === 'snapshot' ? '--out is required' : '--baseline is required');
  const before = command === 'check' ? await load(target) : undefined;
  if (command === 'snapshot' && !force) {
    try { await lstat(target); throw new Error('Snapshot already exists; use --force to replace it'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const snapshot = await captureTools({ command: executable, args: childArgs, timeoutMs, protocol });
  if (before) return report(compareSnapshots(before, snapshot));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${canonical(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    // Same-directory publication preserves the previous baseline on failure.
    // A hard link also makes non-overwrite publication atomic under races.
    if (force) await rename(temporary, target);
    else await link(temporary, target);
    process.stdout.write(`${JSON.stringify({ saved: target, tools: snapshot.tools.length })}\n`);
    return 0;
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function report(result: ReturnType<typeof compareSnapshots>): number {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.verdict === 'breaking' ? 1 : result.verdict === 'review' ? 3 : 0;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) {
  // Never echo server stderr, schemas, environment variables, or nested errors.
  const message = error instanceof Error && !('code' in error) ? error.message : 'File or process operation failed';
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 2;
}
