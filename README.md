# MCP Contract Check

A TypeScript CLI and library for a specific LLM-tooling problem: **an MCP
server can upgrade successfully while silently breaking the input contract
that your agent depends on**.

Snapshot a trusted server's tool inputs, commit the reviewed baseline, and gate
future changes in CI. This is a contract regression checker, not another chat
wrapper, MCP browser, or tool execution framework. No model or API key is needed.

## Status

Implemented: live stdio capture, legacy and modern protocol modes, bounded
pagination, deterministic snapshots, conservative input-schema comparisons,
machine-readable reports, CLI exit codes, deadlines, child-process cleanup,
and atomic baseline publication. The npm artifact is prepared locally; this
package has **not** been published to the npm registry.

## Try it

Requires Node.js 24+ and npm:

```powershell
npm ci --ignore-scripts
npm test
npm run check
node dist/src/cli.js --help
node dist/src/cli.js snapshot --out contract.json -- node dist/test/fixtures/server.js
node dist/src/cli.js check --baseline contract.json -- node dist/test/fixtures/server.js
```

See a real failing gate against the intentionally incompatible fixture:

```powershell
node dist/src/cli.js check --baseline contract.json -- node dist/test/fixtures/server.js breaking
```

It exits 1 and reports that `fetch` was removed. Replace the fixture command
after `--` with your own trusted MCP server executable and arguments.
The executable is spawned directly, never through a shell.

```powershell
node dist/src/cli.js snapshot --out modern.json --protocol 2026-07-28 -- node my-modern-server.mjs
node dist/src/cli.js snapshot --out auto.json --protocol auto -- node my-server.mjs
node dist/src/cli.js diff before.json after.json
```

Legacy initialization is intentionally the default for short-lived CLI use.
`auto` opts into modern discovery and legacy fallback; a legacy peer can cost
an additional disposable probe process. Pinning `2026-07-28` requires a modern
server. Negotiation uses the official
[`@modelcontextprotocol/client` SDK](https://github.com/modelcontextprotocol/typescript-sdk).
The [SDK migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28.html)
explains why spawn-per-invocation tools should not silently default to probing.

## What the gate checks

The comparison direction is **old accepted inputs must remain accepted by the
new server**, not output-schema assignability.

| Change | Result |
| --- | --- |
| Remove a tool; add a required property | Potentially breaking |
| Narrow a type, enum, constant, or supported numeric/length bound | Potentially breaking |
| Remove an accepted property while disallowing extras | Potentially breaking |
| Add an optional field to a previously closed object | Compatible |
| Widen supported bounds or enum values | Compatible |
| Change only descriptions or property order | Compatible |
| Change unsupported schema keywords, or change schemas containing interacting unsupported keywords | Manual review |

This is deliberately conservative, **not a complete JSON Schema inclusion
solver**. Complex references, combinators, patterns, conditional schemas,
unevaluated properties, and custom constraints can require review. Some
restrictive changes may be redundant under other constraints and still be
flagged. Do not silently accept the new baseline just to make CI green.

Only tool names and **input schemas** are captured. Output schemas, tool
behavior, prompt quality, authorization, semantic meaning, resources, and
prompts are outside this version's contract. A compatible input report is not
a claim that the server is safe or its responses are correct.

## CLI and CI contract

Output is JSON, except for `--help`.

| Exit code | Meaning |
| --- | --- |
| 0 | Snapshot saved, or inputs compatible |
| 1 | Potentially breaking contract changes |
| 2 | Invalid CLI arguments, snapshot, file operation, transport, or deadline |
| 3 | Compatibility not proven; manual review required |

`--timeout` bounds the complete capture, from spawn through listing, and must
be 1–120000 milliseconds (default 10000). Cleanup adds a short transport
termination grace period. Catalog limits are 32 pages, 1000 unique tools,
1 MiB per transport message, approximately 4 MiB per snapshot, and 40 levels
for supported nested schema structures. Repeated cursors and duplicate names
are rejected, not accepted as partial contracts.

Snapshots are deterministic and exclude timestamps and server descriptions.
They never overwrite an existing baseline unless `--force` is explicit.
Capture or write failures preserve the previous baseline. Non-overwriting
publication uses a same-directory hard link; use a local filesystem supporting
hard links. `--force` uses same-directory rename.

For CI, first review and commit a baseline for your own server. Then:

```powershell
npm ci --ignore-scripts
npm run build
node dist/src/cli.js check --baseline contract.json -- node my-server.mjs
```

## Library

The packed package exports TypeScript declarations and ESM:

```typescript
import { captureTools, compareSnapshots } from '@kimj0107/mcp-contract-check';

const current = await captureTools({
  command: process.execPath,
  args: ['my-server.mjs'],
  timeoutMs: 10000,
});
const report = compareSnapshots(reviewedBaseline, current);
```

`reviewedBaseline` is your parsed, validated format-1 baseline.
`parseSnapshot` is also exported for validation. No server tool is invoked:
the client only negotiates and requests `tools/list`.

## Architecture and safety

```text
CLI arguments -> official SDK stdio client -> bounded tools/list pages
             -> validated/sorted format-1 snapshot
             -> conservative input comparison -> JSON report + CI exit code
```

Launching an MCP server **executes its code**. Only use trusted commands;
this tool is not a sandbox, and listing tools can itself have server-side
effects. The SDK's standard allowlisted environment is inherited; arbitrary
application secrets are not forwarded explicitly. Child stderr and raw
protocol errors are not echoed. Baseline schemas can still contain sensitive
defaults/examples, so inspect them before committing or sharing.

Capture is point-in-time, not a transactional catalog lock. A server changing
its tools during pagination can make capture fail or produce an inconsistent
catalog; use a stable server build in CI.

## Development

```powershell
npm test
npm run check
npm run smoke:package
```

Tests cover schema-direction mistakes, unknown keyword interactions,
pagination, modern envelopes, legacy fallback, hanging servers, cleanup,
secret-bearing provider errors, overwrite refusal, failed forced capture, CLI
exit codes, and installed-consumer behavior. No benchmark or production
adoption is claimed.

This original project was developed with GitHub Copilot AI assistance.
Anyone presenting it should understand the protocol lifecycle, compatibility
direction, and limitations; generated code alone is not proof of expertise.
Licensed under MIT.
