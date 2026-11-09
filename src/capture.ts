import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseSnapshot, type Snapshot } from './contract.js';

export interface CaptureOptions {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  protocol?: 'legacy' | 'auto' | '2026-07-28';
}

export async function captureTools({
  command, args = [], cwd = process.cwd(), timeoutMs = 10_000, protocol = 'legacy',
}: CaptureOptions): Promise<Snapshot> {
  if (!command || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('A command and timeout from 1 to 120000 ms are required');
  }
  if (!['legacy', 'auto', '2026-07-28'].includes(protocol)) throw new Error('Unsupported protocol mode');
  const client = new Client({ name: 'mcp-contract-check', version: '0.1.0' }, {
    capabilities: {},
    versionNegotiation: {
      mode: protocol === '2026-07-28' ? { pin: protocol } : protocol,
      probe: { timeoutMs: Math.min(timeoutMs, 1000), maxRetries: 0 },
    },
  });
  const transport = new StdioClientTransport({
    command, args, cwd, stderr: 'ignore', maxBufferSize: 1_048_576,
  });
  client.onerror = () => {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let removeAbort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error('MCP capture deadline exceeded'));
    controller.signal.addEventListener('abort', abort, { once: true });
    removeAbort = () => controller.signal.removeEventListener('abort', abort);
  });
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport, { signal: controller.signal, timeout: timeoutMs });
        const tools: { name: string; inputSchema: unknown }[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let bytes = 0;
        for (let page = 0; page < 32; page++) {
          // Use one validated protocol request per page: a contract gate must
          // reject repeated cursors, never accept a silently partial catalog.
          const result = await client.request({
            method: 'tools/list', params: cursor === undefined ? {} : { cursor },
          }, { signal: controller.signal, timeout: timeoutMs });
          for (const tool of result.tools) {
            const contract = { name: tool.name, inputSchema: tool.inputSchema };
            bytes += Buffer.byteLength(JSON.stringify(contract));
            if (tools.length >= 1000 || bytes > 4_194_000) throw new Error('Tool catalog exceeds limits');
            tools.push(contract);
          }
          if (result.nextCursor === undefined) return parseSnapshot({ format: 1, tools });
          if (cursors.has(result.nextCursor)) throw new Error('Repeated pagination cursor');
          cursors.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        throw new Error('Pagination exceeds 32 pages');
      })(),
      deadline,
    ]);
  } catch {
    throw new Error(controller.signal.aborted
      ? 'MCP capture deadline exceeded'
      : 'MCP capture failed; check the trusted server command and protocol mode');
  } finally {
    clearTimeout(timer);
    removeAbort();
    controller.abort();
    await client.close();
    await transport.close();
  }
}
