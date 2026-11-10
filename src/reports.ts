import type { Report } from './contract.js';

function xml(value: string): string {
  return Array.from(value, (character) => {
    const point = character.codePointAt(0)!;
    if (!(point === 9 || point === 10 || point === 13 ||
        (point >= 0x20 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff))) return '\uFFFD';
    return character;
  }).join('').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
    .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
}

function workflow(value: string, property = false): string {
  const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  return property ? escaped.replaceAll(':', '%3A').replaceAll(',', '%2C') : escaped;
}

// Paths can contain sensitive property names. Only emit tool names and fixed finding reasons.
export function renderJUnit(report: Report): string {
  const cases = report.changes.map((change, index) =>
    `    <testcase classname="mcp-contract-check" name="${xml(`${change.tool}: finding ${index + 1}`)}">` +
    `<failure type="${change.severity}" message="${xml(change.reason)}"/></testcase>`);
  if (!cases.length) cases.push('    <testcase classname="mcp-contract-check" name="Inputs compatible"/>');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="mcp-contract-check" tests="${cases.length}" failures="${report.changes.length}" errors="0" skipped="0">`,
    ...cases,
    '</testsuite>',
    '',
  ].join('\n');
}

export function renderGitHubAnnotations(report: Report): string {
  return report.changes.map((change) => {
    const level = change.severity === 'breaking' ? 'error' : 'warning';
    const title = workflow(`MCP contract ${change.severity}: ${change.tool}`, true);
    return `::${level} title=${title}::${workflow(change.reason)}\n`;
  }).join('');
}
