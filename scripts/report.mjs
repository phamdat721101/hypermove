#!/usr/bin/env node
/**
 * scripts/report.mjs
 * ------------------
 * Renders tracking/PERFORMANCE.md from tracking/task-log.json.
 *
 * Outputs:
 *   • Header (project, scope, generated_at)
 *   • Aggregate totals (est, actual, variance %)
 *   • Per-sprint velocity + status breakdown
 *   • Task table with est vs actual + variance
 *   • ASCII burndown chart (cumulative actual hours per task)
 *
 * Zero dependencies. Idempotent. Re-run after every task.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const SRC = path.join(ROOT, 'tracking', 'task-log.json');
const DST = path.join(ROOT, 'tracking', 'PERFORMANCE.md');

const log = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const tasks = log.tasks;

const fmt = (n) => Number(n).toFixed(1);
const pct = (n) => (n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`);

const variance = (est, actual) => (est === 0 ? 0 : ((actual - est) / est) * 100);

const totalEst = tasks.reduce((s, t) => s + (t.est_h || 0), 0);
const totalActual = tasks.reduce((s, t) => s + (t.actual_h || 0), 0);
const totalVariance = variance(totalEst, totalActual);
const done = tasks.filter((t) => t.status === 'done').length;
const pending = tasks.filter((t) => t.status !== 'done').length;

const sprints = [...new Set(tasks.map((t) => t.sprint))].sort();
const sprintAgg = sprints.map((sp) => {
  const ts = tasks.filter((t) => t.sprint === sp);
  const est = ts.reduce((s, t) => s + (t.est_h || 0), 0);
  const actual = ts.reduce((s, t) => s + (t.actual_h || 0), 0);
  const doneCount = ts.filter((t) => t.status === 'done').length;
  return { sprint: sp, count: ts.length, done: doneCount, est, actual, variance: variance(est, actual) };
});

// ASCII burndown — cumulative actual hours over completed tasks.
const burndownWidth = 40;
const completed = tasks.filter((t) => t.status === 'done');
let running = 0;
const burndownRows = completed.map((t) => {
  running += t.actual_h || 0;
  const filled = totalActual === 0 ? 0 : Math.round((running / totalActual) * burndownWidth);
  return `Task ${t.id.padStart(2, ' ')}  │${'█'.repeat(filled)}${'·'.repeat(burndownWidth - filled)}│ ${fmt(running)}h`;
});

const taskTable = tasks
  .map((t) => {
    const v = variance(t.est_h, t.actual_h);
    const refs = (t.prd_refs || []).join(', ');
    const flag = t.status === 'done' ? '✅' : '⏳';
    return `| ${t.id} | ${t.sprint} | ${flag} | ${escapeMd(t.title)} | ${refs} | ${fmt(t.est_h)} | ${fmt(t.actual_h)} | ${pct(v)} |`;
  })
  .join('\n');

const sprintTable = sprintAgg
  .map(
    (s) =>
      `| ${s.sprint} | ${s.done}/${s.count} | ${fmt(s.est)} | ${fmt(s.actual)} | ${pct(s.variance)} |`,
  )
  .join('\n');

const generated = new Date().toISOString();

const md = `# HyperMove — Performance Report

> Auto-generated from \`tracking/task-log.json\` via \`pnpm report\`.
> Last regenerated: **${generated}**

## Project

- **Name:** \`${log.project}\`
- **Scope:** ${log.scope}
- **PRD:** \`${log.prd_root}\`
- **Started:** ${log.started_at}

## Aggregate

| Metric | Value |
|---|---|
| Tasks | ${tasks.length} (${done} done / ${pending} pending) |
| Estimated hours | **${fmt(totalEst)}h** |
| Actual hours | **${fmt(totalActual)}h** |
| Variance | **${pct(totalVariance)}** |
| Avg variance / task | ${pct(totalVariance / tasks.length)} |

## Sprint velocity

| Sprint | Done / Total | Est (h) | Actual (h) | Variance |
|---|---|---|---|---|
${sprintTable}

## Burndown (cumulative actual hours)

\`\`\`
${burndownRows.join('\n')}
\`\`\`

Total: **${fmt(totalActual)}h** across **${completed.length}** completed task(s).

## Tasks

| # | Sprint | Status | Title | PRD refs | Est (h) | Actual (h) | Variance |
|---|---|---|---|---|---|---|---|
${taskTable}

## Method

Each task entry carries:
- \`id\`            — internal sequential ID
- \`sprint\`        — S1 or S2 (MVP scope)
- \`prd_refs\`      — original PRD task IDs (T-001 … T-050)
- \`est_h\`         — estimate from the PRD sub-PRDs
- \`actual_h\`      — wall-clock engineering time logged on completion
- \`status\`        — \`pending\` | \`in_progress\` | \`done\`

Variance is computed as \`(actual − est) / est × 100%\`. Negative = under budget.

End of report.
`;

fs.writeFileSync(DST, md);
console.log(`✓ PERFORMANCE.md regenerated → ${path.relative(ROOT, DST)}`);
console.log(`  Tasks:    ${done}/${tasks.length} done`);
console.log(`  Est:      ${fmt(totalEst)}h`);
console.log(`  Actual:   ${fmt(totalActual)}h`);
console.log(`  Variance: ${pct(totalVariance)}`);

function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|');
}
