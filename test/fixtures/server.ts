import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'normal';
const marker = process.argv[3];
if (marker) appendFileSync(marker, `${process.pid}\n`);
const tools = [
  { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'fetch', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
];
const lines = createInterface({ input: process.stdin });
const modern = mode === 'modern';
const meta = { 'io.modelcontextprotocol/serverInfo': { name: 'contract-fixture', version: '1.0.0' } };
lines.on('line', (line) => {
  const request = JSON.parse(line) as { id?: number; method: string; params?: { cursor?: string; protocolVersion?: string; _meta?: Record<string, unknown> } };
  if (request.id === undefined || mode === 'hang') return;
  const respond = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  const reject = (code: number, message: string) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message } })}\n`);
  if (request.method === 'server/discover' && modern) {
    respond({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, _meta: meta, ttlMs: 0, cacheScope: 'private' });
  } else if (request.method === 'initialize' && !modern) {
    respond({ protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'contract-fixture', version: '1.0.0' } });
  } else if (request.method === 'tools/list') {
    if (mode === 'error') { process.stderr.write('fixture-sensitive-stderr\n'); reject(-32603, 'fixture-sensitive-error'); return; }
    if (modern && request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28') {
      reject(-32602, 'Missing modern protocol envelope');
      return;
    }
    const result = mode === 'paginate'
      ? request.params?.cursor ? { tools: [tools[1]] } : { tools: [tools[0]], nextCursor: 'second' }
      : mode === 'loop' ? { tools: [tools[0]], nextCursor: String(Number(request.params?.cursor ?? 0) + 1) }
      : mode === 'repeat-cursor' ? { tools: [tools[0]], nextCursor: 'same' }
      : { tools: mode === 'breaking' ? [tools[0]] : tools };
    respond(modern ? { resultType: 'complete', ...result, _meta: meta, ttlMs: 0, cacheScope: 'private' } : result);
  } else reject(-32601, 'Unknown method');
});
lines.on('close', () => process.exit(0));
