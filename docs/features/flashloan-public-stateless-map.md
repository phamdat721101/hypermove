# System Map: flashloan-public-stateless

```json nim-deliver
{
  "featureId": "flashloan-public-stateless",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "Credential-free public MCP tools/call",
    "payload": "Strict stateless inputs, optional proven state, or bounded four-chain mover filters and seeds"
  },
  "processing": {
    "apiHops": [
      "public MCP -> authenticated loopback direct worker",
      "worker -> allowlisted HTTPS RPC; bounded compute thread or Rust process",
      "worker -> official DexScreener feeds/search -> capped token batches -> representative market -> ranked movers"
    ],
    "datastores": [
      "No public repository or knowledge writes; bounded ephemeral admission counters only"
    ],
    "services": [
      "Next.js public adapter",
      "existing research worker",
      "Node worker threads",
      "Rust engine"
    ]
  },
  "output": {
    "state": "Inline research data/report and integrity envelope where reusable",
    "transitions": [
      "validated -> admitted -> executed -> output verified",
      "failure or cancellation -> resources released",
      "mover source failure/internal deadline -> explicit per-chain partial/unavailable outcomes",
      "caller disconnect -> scan cancellation -> no output publication"
    ]
  },
  "seams": [
    {
      "id": "transport",
      "description": "Credential-free public ingress and protected internal transport"
    },
    {
      "id": "rpc",
      "description": "Dependency timeouts and cancellation"
    },
    {
      "id": "admission",
      "description": "Shared capacity and bounded per-IP quota"
    },
    {
      "id": "validation",
      "description": "Strict inputs and tamper-evident inline state"
    },
    {
      "id": "verification",
      "description": "Verified direct output with no persistence/broadcasting"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "transport",
      "command": "pnpm flashloan:public-e2e",
      "logMarker": "EDGE-01",
      "sourceFiles": [
        "src/lib/mcp/flashloan/client.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "rpc",
      "command": "pnpm flashloan:public-e2e",
      "logMarker": "EDGE-02",
      "sourceFiles": [
        "src/lib/mcp/flashloan/public-worker.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "admission",
      "command": "pnpm flashloan:public-e2e",
      "logMarker": "EDGE-03",
      "sourceFiles": [
        "src/lib/mcp/flashloan/admission.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "validation",
      "command": "pnpm flashloan:public-e2e",
      "logMarker": "EDGE-04",
      "sourceFiles": [
        "src/lib/mcp/flashloan/public-proof.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "verification",
      "command": "pnpm flashloan:public-e2e",
      "logMarker": "EDGE-05",
      "sourceFiles": [
        "src/lib/mcp/flashloan/public-worker.ts"
      ]
    }
  ]
}
```
