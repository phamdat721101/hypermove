# System Map: flashloan-pool-coverage

```json nim-deliver
{
  "featureId": "flashloan-pool-coverage",
  "taskType": "feature",
  "status": "Done",
  "input": {
    "entrypoint": "MCP SDK/raw tools/call through public or owned worker transport",
    "payload": "Strict network-specific tokens, pool refs or inline proven state"
  },
  "processing": {
    "apiHops": [
      "MCP -> authenticated worker -> provider HTTPS GraphQL/gRPC/EVM",
      "worker -> isolated compute/Rust/native Sui dry-run"
    ],
    "datastores": [
      "Private owned repository only; public ephemeral admission state; offline development knowledge"
    ],
    "services": [
      "Next.js MCP adapter",
      "shared research worker",
      "Rust REVM",
      "native Move node"
    ]
  },
  "output": {
    "state": "Inventory, proven snapshot/plan or explicit research outcome; execution disabled",
    "transitions": [
      "validated -> admitted -> enumerated -> state verified -> sized -> simulated -> output verified",
      "provider failure -> partial coverage or typed failure",
      "deadline/cancellation -> lease release and no publication"
    ]
  },
  "seams": [
    {
      "id": "transport",
      "description": "Versioned protected internal transport and public SDK boundary"
    },
    {
      "id": "dependency",
      "description": "Provider timeout and cancellation"
    },
    {
      "id": "ownership",
      "description": "Private ownership and shared public admission"
    },
    {
      "id": "schema",
      "description": "Typed identifiers and proof/schema versions"
    },
    {
      "id": "publication",
      "description": "Verified output, repayment and cancellation"
    }
  ],
  "edgeProofs": [
    {
      "edgeId": "EDGE-01",
      "seamId": "transport",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-01",
      "sourceFiles": [
        "tests/flashloan-worker.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-02",
      "seamId": "dependency",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-02",
      "sourceFiles": [
        "tests/flashloan-worker.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-03",
      "seamId": "ownership",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-03",
      "sourceFiles": [
        "tests/flashloan-worker.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-04",
      "seamId": "schema",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-04",
      "sourceFiles": [
        "tests/flashloan-worker.test.ts"
      ]
    },
    {
      "edgeId": "EDGE-05",
      "seamId": "publication",
      "command": "pnpm exec vitest run tests/flashloan-worker.test.ts -t 'delivery boundary markers' --reporter=dot",
      "logMarker": "EDGE-05",
      "sourceFiles": [
        "tests/flashloan-worker.test.ts"
      ]
    }
  ]
}
```

## Native acceptance

See flashloan-pool-coverage.md. This map records local implementation acceptance;
production registry approval and rollout are separate. No signing or broadcasting.
