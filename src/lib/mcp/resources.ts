/**
 * src/lib/mcp/resources.ts
 * -------------------------
 * MCP resources — subscribable live data exposed through the MCP resource API.
 * Resources are read-only, cacheable, and can be polled for updates.
 *
 * SOLID:
 *  - Single Responsibility: each resource is a thin wrapper over existing reads.
 *  - Open/Closed: add new resources by appending to RESOURCES map.
 */

import { isMcpResourcesEnabled, isMcpFlareEnabled, isMcpXrplV3Enabled } from '../platform-flag';

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read(): Promise<unknown>;
}

/** FTSO feed resource — live price feed from Flare FTSO (keyless). */
const ftsoFeedResource: McpResource = {
  uri: 'ftso://feeds/{feedId}',
  name: 'FTSO Price Feed',
  description: 'Live block-latency price feed from Flare FTSO (free 1000-feed oracle). Replace {feedId} with e.g. BTC/USD.',
  mimeType: 'application/json',
  async read() {
    if (!isMcpFlareEnabled()) {
      return { error: 'FTSO resource disabled', hint: 'set FEATURE_MCP_FLARE=true' };
    }
    // The actual read is dispatched through the data.call tool
    return { hint: 'Use data.call(chain: "flare-mainnet", method: "flareFtsoFeed", params: { feed: "BTC/USD" })' };
  },
};

/** XRPL amendments resource — enabled + voting amendments. */
const amendmentsResource: McpResource = {
  uri: 'xrpl://amendments',
  name: 'XRPL Amendments',
  description: 'Enabled + in-voting amendments (fixCleanup, XLS-65/66). Feature-gate awareness.',
  mimeType: 'application/json',
  async read() {
    if (!isMcpXrplV3Enabled()) {
      return { error: 'XRPL v3 resource disabled', hint: 'set FEATURE_MCP_XRPL_V3=true' };
    }
    return { hint: 'Use data.call(chain: "xrpl-mainnet", method: "xrplAmendments")' };
  },
};

/** FXRP capacity resource — Flare FAssets XRP bridge capacity. */
const fxrpCapacityResource: McpResource = {
  uri: 'flare://fxrp/capacity',
  name: 'FXRP Bridge Capacity',
  description: 'FAssets XRP bridge capacity on Flare (collateral + mint state).',
  mimeType: 'application/json',
  async read() {
    if (!isMcpFlareEnabled()) {
      return { error: 'FXRP resource disabled', hint: 'set FEATURE_MCP_FLARE=true' };
    }
    return { hint: 'Use data.call(chain: "flare-mainnet", method: "flareFassetsFxrp")' };
  },
};

/** All resources, gated by the master flag. */
export function getResources(): McpResource[] {
  if (!isMcpResourcesEnabled()) return [];
  return [ftsoFeedResource, amendmentsResource, fxrpCapacityResource];
}

/** Find a resource by URI pattern. */
export function findResource(uri: string): McpResource | undefined {
  return getResources().find((r) => uri.startsWith(r.uri.split('{')[0]));
}
