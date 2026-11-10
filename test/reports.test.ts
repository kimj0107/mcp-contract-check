import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Report } from '../src/contract.js';
import { renderGitHubAnnotations, renderJUnit } from '../src/reports.js';

test('JUnit escapes attribute data, preserves whitespace, and replaces invalid XML characters', () => {
  const report: Report = {
    verdict: 'review', addedTools: ['not-emitted'],
    changes: [{
      tool: `a<&>"'\t\r\n\u0000\uD800\u{1F600}`,
      path: '/inputSchema/properties/schema-secret',
      severity: 'review',
      reason: `review <&>"'\n`,
    }],
  };
  assert.equal(renderJUnit(report), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuite name="mcp-contract-check" tests="1" failures="1" errors="0" skipped="0">',
    '    <testcase classname="mcp-contract-check" name="a&lt;&amp;&gt;&quot;&apos;&#9;&#13;&#10;\uFFFD\uFFFD\u{1F600}: finding 1">' +
      '<failure type="review" message="review &lt;&amp;&gt;&quot;&apos;&#10;"/></testcase>',
    '</testsuite>',
    '',
  ].join('\n'));
});

test('workflow escaping cannot inject commands or properties and is not double-decoded', () => {
  const tool = 'name,other=value:%0A\r\n::error::injected';
  const reason = 'reason%0D%0A\r\n::notice::injected';
  const report: Report = {
    verdict: 'breaking', addedTools: [],
    changes: [
      { tool, path: 'schema-secret', reason, severity: 'breaking' },
      { tool: 'review', path: 'schema-secret', reason: 'Manual review', severity: 'review' },
    ],
  };
  const output = renderGitHubAnnotations(report);
  assert.equal(output,
    '::error title=MCP contract breaking%3A name%2Cother=value%3A%250A%0D%0A%3A%3Aerror%3A%3Ainjected::' +
    'reason%250D%250A%0D%0A::notice::injected\n' +
    '::warning title=MCP contract review%3A review::Manual review\n');
  const first = output.split('\n')[0]!;
  const separator = first.indexOf('::', 2);
  assert.equal(decodeURIComponent(first.slice(14, separator)), `MCP contract breaking: ${tool}`);
  assert.equal(decodeURIComponent(first.slice(separator + 2)), reason);
  assert.doesNotMatch(output, /schema-secret/);
});

test('compatible reports contain a passing JUnit case and no workflow commands', () => {
  const report: Report = { verdict: 'compatible', changes: [], addedTools: ['new-tool'] };
  assert.match(renderJUnit(report), /tests="1" failures="0" errors="0" skipped="0"/);
  assert.match(renderJUnit(report), /<testcase classname="mcp-contract-check" name="Inputs compatible"\/>/);
  assert.equal(renderGitHubAnnotations(report), '');
});
