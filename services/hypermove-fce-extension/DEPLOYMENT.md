# Deployment — hypermove-fce-extension

This covers deploying **this extension** and how it fits into the two other
pieces of the real system it depends on. It does not duplicate their own
deployment docs — it cross-references them and states exactly where this
extension's config has to match theirs.

## The three pieces, and who deploys what

| Piece | What it is | Where it's documented | Who runs it |
|---|---|---|---|
| **HyperMove MCP gateway** | `hypermove-app` (Next.js), the actual data/tool source this extension calls | `hypermove-app/README.md` ("Deploy" section) | HyperMove (already running at `hypermove.duckdns.org`) |
| **Flare TEE Proxy + TEE Node** | `ext-proxy` + `extension-tee` (Go), the real Flare Confidential Compute infra | `services/tee-extension/README.md` | Whoever registers the Flare Compute Extension (HyperMove, per Sub-PRD A) |
| **This extension** | The `/action` task-logic handler the TEE node forwards to | this file | Same operator as the TEE Node — must run on the same Docker network/host, since the TEE node calls it over an unauthenticated loopback boundary |

**This extension is never deployed standalone in a way that does anything
useful.** It only receives real traffic once it's wired in as the
`extension-tee` container's forward target, replacing (or standing beside)
the Go scaffold binary. It is, however, independently useful to run for
local development/testing against a real HyperMove endpoint even without a
live TEE node, using `curl` directly against `POST :8889/action` — see
"Local development" below.

## 1. HyperMove side — already deployed, nothing new required here

This extension talks to `https://hypermove.duckdns.org/api/mcp` (or a self-hosted
`hypermove-app` instance) as an ordinary external HTTP client, authenticated
via `HYPERMOVE_MCP_ADMIN_TOKEN` — the same admin-bypass token already
supported by `hypermove-app`'s `src/lib/mcp/auth.ts`. No changes to
`hypermove-app` are required to support this extension; it looks like any
other authenticated MCP caller from HyperMove's side.

To get a token: it's `hypermove-app`'s `HYPERMOVE_MCP_ADMIN_TOKEN` environment
variable — whoever operates the `hypermove-app` deployment sets this value
and shares it with whoever operates this extension. **Known tradeoff** (see
this project's main `README.md`): this token has full admin-tier access to
the HyperMove gateway, not scoped to this extension's use case.

## 2. Flare TEE Proxy + TEE Node side — real, named blockers

Per `services/tee-extension/README.md`, getting a real Flare Compute
Extension registered and running on Coston2 requires two things this session
(and most local setups) cannot obtain automatically:

1. **Flare indexer-DB credentials** for `ext-proxy` — request via Flare
   support / `@FlareDevs`.
2. **A public HTTPS tunnel** to `ext-proxy`'s port (e.g. `ngrok http 6674` or
   `cloudflared tunnel --url http://localhost:6674`) so Flare's data
   providers can reach it.

Until both are available, the TEE Proxy/Node pair can only run in the
**local end-to-end mode** the extension-scaffold's own
`docker-compose.yaml` already sets up (Hardhat local chain, `CHAIN_ID=31337`,
`SIMULATED_TEE=true`) — real enough to exercise the full pipeline
end-to-end, but not reachable by real Coston2 traffic.

**Real ports in that compose file** (different from this project's
8888/8889 defaults — verified by reading the file directly, not assumed):

```yaml
# services/tee-extension/extension-examples/extension-scaffold/docker-compose.yaml
extension-tee:
  environment:
    - PROXY_URL=http://ext-proxy:6663
    - CONFIG_PORT=5501
    - SIGN_PORT=7701        # this extension's TEE_SIGN_URL must point here
    - EXTENSION_PORT=7702   # this extension's own listening port must match this
```

## 3. Wiring this extension into the real compose stack

The Go `extension-tee` container in that compose file **is** the thing whose
`/action` forwarding target this extension replaces. Two ways to do this,
in increasing order of "real":

### Option A — swap the container image (recommended for an actual deployment)

Add an override compose file in this directory (`services/hypermove-fce-extension/`)
that replaces the `extension-tee` service's `build` context with this
project's own `Dockerfile`, keeping the same `SIGN_PORT`/`EXTENSION_PORT`
env vars so the TEE Proxy's routing config needs zero changes:

```yaml
# services/hypermove-fce-extension/docker-compose.override.yaml
# Run alongside ../tee-extension/extension-examples/extension-scaffold/docker-compose.yaml:
#   docker compose -f ../tee-extension/extension-examples/extension-scaffold/docker-compose.yaml \
#                   -f docker-compose.override.yaml up
services:
  extension-tee:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - TEE_EXTENSION_PORT=7702
      - TEE_SIGN_URL=http://extension-tee:7701   # the TEE node's OWN sign server, same container's other port
      - HYPERMOVE_MCP_URL=${HYPERMOVE_MCP_URL:-https://hypermove.duckdns.org/api/mcp}
      - HYPERMOVE_MCP_ADMIN_TOKEN=${HYPERMOVE_MCP_ADMIN_TOKEN}
    ports:
      - "7702:7702"
```

**Confirmed real constraint** (read directly from
`tee-node/internal/processors/instructions/default.go`'s `DefaultProcessor.Process()`):

```go
result, err := extension.PostActionToExtension(
  fmt.Sprintf("http://localhost:%d/action", p.extensionPort), a)
```

The real Go TEE node **hardcodes `localhost`** — it is not a configurable
URL/hostname. This means the two-container topology below **only works if
both containers share the same network namespace** (so `localhost` inside
the TEE node's container actually resolves to this extension's listener).
There is no Go-side env var to point it at a different hostname; this is
not a gap in this project's config, it's a hard constraint of the real
vendored binary.

```yaml
services:
  extension-tee:            # the REAL Go TEE node — keep this, do not replace it
    build:
      context: ../../tee-node    # or wherever the real tee-node Dockerfile lives
    environment:
      - SIGN_PORT=7701
      - EXTENSION_PORT=7702   # TEE node will call http://localhost:7702/action

  hypermove-fce-extension:  # THIS project — must share extension-tee's network namespace
    build:
      context: .
    network_mode: "service:extension-tee"   # REQUIRED — makes localhost:8889 inside this
                                             # container the SAME localhost:8889 the TEE
                                             # node's own process sees, since it hardcodes
                                             # "http://localhost:<extensionPort>/action"
    environment:
      - TEE_EXTENSION_PORT=7702   # MUST match extension-tee's EXTENSION_PORT above
      - TEE_SIGN_URL=http://localhost:7701   # same shared network namespace, same host
      - HYPERMOVE_MCP_URL=${HYPERMOVE_MCP_URL:-https://hypermove.duckdns.org/api/mcp}
      - HYPERMOVE_MCP_ADMIN_TOKEN=${HYPERMOVE_MCP_ADMIN_TOKEN}
    # no `ports:` here — network_mode: service:X containers cannot publish their own ports;
    # publish 7702/7701 on the extension-tee service definition instead if external access is needed
```

`network_mode: "service:extension-tee"` is Docker Compose's way of putting
a container inside another service's network namespace (equivalent to
`docker run --network container:<id>`) — this is the correct, verified fix
for the hardcoded-`localhost` constraint above, not a workaround for an
unverified guess.

### Option B — run this extension directly on the host, alongside a
locally-run TEE node binary (simpler for local dev, matches how
`services/tee-extension/README.md`'s own "Local build & test" section
runs things without Docker at all)

```bash
# terminal 1 — the real Go TEE node in Extension Mode (from services/tee-extension/)
cd ../tee-extension/extension-examples/extension-scaffold
SIGN_PORT=8888 EXTENSION_PORT=8889 go run ./cmd/docker

# terminal 2 — this extension
cd ../../hypermove-fce-extension
npm run dev
```

Both processes on `localhost` means `TEE_EXTENSION_PORT=8889` (this
extension) and `TEE_SIGN_URL=http://localhost:8888` (pointing at the real
Go node) work with zero network-namespace tricks — this is the
configuration this project's own integration tests assume.

## 4. This extension's own deployment (once wired to a real TEE node)

```bash
cp .env.example .env   # fill in HYPERMOVE_MCP_ADMIN_TOKEN at minimum
npm install
npm run build          # tsc -p tsconfig.json → dist/index.js (verified: boots + serves real HTTP, see below)
node dist/index.js      # or: docker build -t hypermove-fce-extension . && docker run --env-file .env -p 8889:8889 hypermove-fce-extension
```

Verified in this session (Docker itself was not available to test — no
running daemon — so the Docker image build/run path is NOT independently
verified end-to-end, only the underlying `npm run build` + `node dist/index.js`
path):

```
$ HYPERMOVE_MCP_ADMIN_TOKEN=smoke-test-token TEE_EXTENSION_PORT=18889 node dist/index.js
hypermove-fce-extension listening on :18889 (POST /action)
$ curl http://localhost:18889/healthz
{"ok":true,"version":"0.1.0"}
```

Fails fast and clearly if misconfigured (Task 10 / F005):

```
$ node dist/index.js
Error: HYPERMOVE_MCP_ADMIN_TOKEN is not set. This extension cannot
authenticate to HyperMove's MCP gateway without it — see .env.example and
README.md "Known tradeoff: admin-token reuse".
```

## Local development without a live TEE node

Since the wire format is fully specified (`src/action-codec.ts`), you can
exercise the whole HyperMove-calling path with a hand-built `Action` payload
and no TEE node at all:

```bash
npm run dev   # localhost:8889

# In another terminal — build a real wire-format Action and POST it:
node -e "
const { toOpHash, encodeGenericAgentTaskMessage } = require('./dist/action-codec.js');
const originalMessage = encodeGenericAgentTaskMessage('SEARCH', { query: 'flare tee' });
const action = {
  data: {
    id: '0x01',
    submissionTag: 'submit',
    message: JSON.stringify({
      opType: toOpHash('GENERIC_AGENT_TASK'),
      opCommand: toOpHash('SEARCH'),
      originalMessage,
    }),
  },
};
console.log(JSON.stringify(action));
" | curl -s -X POST http://localhost:8889/action -H 'content-type: application/json' -d @-
```

This is exactly what `test/index.test.ts` does programmatically (with mocked
upstreams) — running it against a real `HYPERMOVE_MCP_ADMIN_TOKEN` and a
real (or locally-run) TEE node's `/sign` gives you the real end-to-end
result.

## Environment variables reference

| Var | Required | Default | Notes |
|---|---|---|---|
| `HYPERMOVE_MCP_ADMIN_TOKEN` | **Yes** | — | Fails fast at startup if unset |
| `HYPERMOVE_MCP_URL` | No | `https://hypermove.duckdns.org/api/mcp` | Point at a self-hosted `hypermove-app` if needed |
| `TEE_SIGN_URL` | No | `http://localhost:8888` | Must match wherever the real TEE node's sign server actually listens — **not always 8888**, see the real compose file's `SIGN_PORT=7701` override above |
| `TEE_EXTENSION_PORT` | No | `8889` | This extension's own listening port — must match whatever the TEE node's `ForwardRouter` is configured to forward to |
