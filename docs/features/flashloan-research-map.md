# System Map: flashloan-research

```json nim-deliver
{
  "featureId": "flashloan-research",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "MCP tools/call",
    "payload": "Validated research input plus authenticated session identity"
  },
  "processing": {
    "apiHops": [
      "MCP gateway -> authenticated loopback worker",
      "worker -> allowlisted HTTPS market RPC"
    ],
    "datastores": [
      "PostgreSQL owned jobs",
      "content-addressed worker artifacts",
      "owner-scoped file-backed nim knowledge"
    ],
    "services": [
      "Next.js gateway",
      "flashloan worker",
      "Rust EVM subprocess"
    ]
  },
  "output": {
    "state": "Owned reproducible research report",
    "transitions": [
      "QUEUED -> RUNNING",
      "RUNNING -> SUCCEEDED|FAILED|CANCELLED"
    ]
  },
  "seams": [
    {
      "id": "transport",
      "description": "Authenticated MCP/worker transport"
    },
    {
      "id": "rpc",
      "description": "Bounded external market reads"
    },
    {
      "id": "storage",
      "description": "Owner-scoped jobs and immutable artifacts"
    },
    {
      "id": "validation",
      "description": "Canonical nested input schemas"
    },
    {
      "id": "verification",
      "description": "Report verification and evidence activation"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "transport",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-01",
      "sourceFiles": [
        "src/lib/mcp/flashloan/client.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "rpc",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-02",
      "sourceFiles": [
        "src/lib/mcp/flashloan/transport.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "storage",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-03",
      "sourceFiles": [
        "src/lib/mcp/flashloan/storage.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "validation",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-04",
      "sourceFiles": [
        "src/lib/mcp/flashloan/worker.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "verification",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-05",
      "sourceFiles": [
        "src/lib/mcp/flashloan/storage.ts"
      ]
    }
  ]
}
```

## Input Flow

Gateway derives the owner from the session, validates the complete input, then
dispatches an authenticated job. Worker revalidates the operation and payload.

## Processing Pipeline

Discovery -> pinned snapshot -> sequential pool quotes -> bounded allocation ->
simulation -> strict report -> optional cited memory proposal. Rust failure cannot
terminate the gateway; workers bound output, runtime and concurrent jobs.

## Output State

Cancellation and failure never publish successful reports. Restarted running jobs
fail explicitly. Artifact references are hashes, not user-selected filesystem paths.
