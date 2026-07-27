/**
 * src/instrumentation-node.ts
 * ------------------------------
 * PRD-D (2026-07-27, Dream Cycle server-side scheduler). Only ever imported
 * from src/instrumentation.ts's register(), and only inside the
 * `NEXT_RUNTIME === 'nodejs'` branch — see that file's header comment for
 * why the split exists (keeps Node-only deps like `pg` out of any
 * non-Node.js bundle webpack might otherwise try to statically resolve
 * this file's transitive imports into).
 */

import { isMcpDreamSchedulerEnabled } from './lib/platform-flag';
import { startDreamScheduler } from './lib/mcp/dream/scheduler';

if (isMcpDreamSchedulerEnabled()) {
  startDreamScheduler();
  // eslint-disable-next-line no-console
  console.log('[dream-scheduler] started (hourly tick, FEATURE_MCP_DREAM_SCHEDULER=true)');
}
