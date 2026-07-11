/**
 * src/lib/harness/output-enforcer.ts
 * ----------------------------------
 * The "enforce, don't instruct" verify-gate. Before a skill's output ships,
 * run its declared verify strategies. On failure, if the skill opted into
 * self-heal, feed the structured failure back and re-execute (bounded). This
 * runs INSIDE the harness runtime, so an agent cannot bypass it (the analog of
 * a pre-commit hook that `--no-verify` cannot skip).
 *
 * Strategies are data-only (serializable) so a skill manifest fully declares
 * its contract; the check logic lives here.
 */

import type { OutputEnforceConfig, VerifyStrategy, CheckResult, EnforceResult } from './types';

type ReExecute = (feedback: string) => Promise<Record<string, unknown>> | Record<string, unknown>;

function get(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

function runStrategy(output: Record<string, unknown>, s: VerifyStrategy): CheckResult {
  switch (s.kind) {
    case 'nonempty': {
      const pass = output != null && Object.keys(output).length > 0;
      return { strategy: 'nonempty', pass, reason: pass ? undefined : 'output is empty' };
    }
    case 'json': {
      try {
        JSON.stringify(output);
        return { strategy: 'json', pass: true };
      } catch {
        return { strategy: 'json', pass: false, reason: 'output is not JSON-serializable' };
      }
    }
    case 'schema': {
      const missing = s.required.filter((f) => get(output, f) === undefined);
      const pass = missing.length === 0;
      return { strategy: `schema(${s.required.join(',')})`, pass, reason: pass ? undefined : `missing required fields: ${missing.join(', ')}` };
    }
    case 'math': {
      // invoice-sum: sum of {amount} over itemsField must equal totalField (± 1 cent).
      const items = get(output, s.itemsField);
      const total = Number(get(output, s.totalField));
      if (!Array.isArray(items) || Number.isNaN(total)) {
        return { strategy: 'math(invoice-sum)', pass: false, reason: `cannot read "${s.itemsField}" (array) and "${s.totalField}" (number)` };
      }
      const sum = items.reduce((acc: number, it) => acc + Number((it as Record<string, unknown>)?.amount ?? 0), 0);
      const pass = Math.abs(sum - total) < 0.01;
      return { strategy: 'math(invoice-sum)', pass, reason: pass ? undefined : `line-item sum ${sum.toFixed(2)} != total ${total.toFixed(2)}` };
    }
    default:
      return { strategy: 'unknown', pass: true };
  }
}

/**
 * Verify `output` against `config.verify`. On failure with onFail:'self-heal',
 * feed the joined failure reasons back into `reExecute` and retry up to maxHeals.
 */
export async function verifyOrHeal(
  output: Record<string, unknown>,
  config: OutputEnforceConfig,
  opts: { reExecute?: ReExecute } = {},
): Promise<EnforceResult> {
  const maxHeals = Math.min(Math.max(config.maxHeals ?? 3, 0), 5);
  let current = output;
  let heals = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const checks = config.verify.map((s) => runStrategy(current, s));
    const failed = checks.filter((c) => !c.pass);
    if (failed.length === 0) return { verified: true, heals, checks, output: current };

    if (config.onFail !== 'self-heal' || !opts.reExecute || heals >= maxHeals) {
      return { verified: false, heals, checks, output: current };
    }

    const feedback = `output-enforcer rejected the previous result: ${failed.map((c) => c.reason).filter(Boolean).join('; ')}. Fix and return again.`;
    current = await opts.reExecute(feedback);
    heals += 1;
  }
}
