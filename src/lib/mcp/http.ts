/**
 * src/lib/mcp/http.ts
 * -------------------
 * One outbound-fetch helper with a hard timeout. Written once and reused by
 * every module that calls an external API, so no adapter re-implements timeout
 * handling (and none can forget it → no serverless hang defeating mock fallback).
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
