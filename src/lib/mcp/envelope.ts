/**
 * src/lib/mcp/envelope.ts
 * -----------------------
 * The ONE envelope contract for the MCP Gateway (Raven pattern, adopted verbatim).
 * Every provider adapter, tool handler, and payment rail returns a ServiceResult<T>.
 * Written once here and reused everywhere — no module re-implements it.
 *
 * SOLID:
 *  - Single Responsibility: this file defines the result shape + two constructors
 *    + the guard prelude. No I/O, no business logic.
 *  - Interface Segregation: ServiceResult is the minimal contract consumers project.
 *
 * Key distinction (why agent code stays robust):
 *   kind: "error"      → the call failed / bad args.
 *   kind: "soft-empty" → the service returned nothing. NOT evidence of absence.
 */

export interface ServiceError {
  service: string;
  kind: 'error' | 'soft-empty';
  message: string;
  status?: number;
  code?: string;
  hint?: string;
}

export type ServiceResult<T> = { ok: true; data: T } | { ok: false; error: ServiceError };

/** Construct a success envelope. */
export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

/** Construct a failure envelope. `kind` defaults to "error". */
export function fail(
  service: string,
  message: string,
  opts: Partial<Omit<ServiceError, 'service' | 'message'>> = {},
): { ok: false; error: ServiceError } {
  return { ok: false, error: { service, message, kind: opts.kind ?? 'error', ...opts } };
}

/** Convenience: service returned nothing (not an error). */
export function softEmpty(service: string, message: string, hint?: string): { ok: false; error: ServiceError } {
  return fail(service, message, { kind: 'soft-empty', hint });
}

/**
 * Guard prelude — installs non-enumerable accessor traps so that reading a
 * payload key at the WRONG level (e.g. `r.projects` instead of `r.data.projects`)
 * throws with a corrective hint, instead of silently returning `undefined`.
 *
 * Deliberately NOT a Proxy (Proxies break structured-clone / RPC serialization).
 * Object.keys / spread / JSON.stringify stay untouched — only direct wrong-level
 * property GETs trip a trap.
 */
export function guardEnvelope<T extends ServiceResult<unknown>>(envelope: T): T {
  const payloadKeys = envelope.ok ? Object.keys(envelope.data as object) : [];

  for (const key of payloadKeys) {
    if (key === 'data' || key === 'error' || key === 'ok') continue;
    if (Object.prototype.hasOwnProperty.call(envelope, key)) continue;

    Object.defineProperty(envelope, key, {
      configurable: true,
      enumerable: false,
      get() {
        throw new TypeError(
          `[envelope] read "${key}" on the envelope — did you mean "data.${key}"? ` +
            `Access the payload via the ".data" property.`,
        );
      },
      set(value: unknown) {
        // Self-replace with a plain property so intentional writes work.
        Object.defineProperty(envelope, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
    });
  }

  return envelope;
}
