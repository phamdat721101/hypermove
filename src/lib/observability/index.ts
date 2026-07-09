/**
 * src/lib/observability/index.ts
 * ------------------------------
 * Public barrel — stable API surface for the future @hypermove/observability
 * npm package. Do not re-export internal helpers.
 */

export { wrapAgentEndpoint, wrapMcpTool, McpToolDenied } from './wrap';
export type { SentinelCheck, WrapAgentOptions, WrapMcpToolOptions } from './wrap';
export { captureEvent, captureEventSync, getDefaultSink } from './capture';
export type { EventSink } from './capture';
export type { AgentEvent, AgentEventKind, PolicyHit } from './types';
export { validateAgentEvent } from './types';
