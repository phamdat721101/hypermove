/**
 * src/lib/security/index.ts
 * -------------------------
 * Public barrel for the agentjacking-defense guard.
 */

export { guard, _resetGuardForTests } from './guard';
export type { GuardOptions, GuardOutcome, RequestContext } from './guard';
