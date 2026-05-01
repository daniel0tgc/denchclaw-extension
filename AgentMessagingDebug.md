# Agent Messaging Failure — Full Debug Reference

This file is a complete reference for diagnosing and fixing the failure where
sending a message to the DenchClaw agent results in either:

- `GET /api/chat/stream?sessionId=<uuid> 404 (Not Found)` looping in the
  browser console, OR
- `Failed to start agent: pairing required: device is asking for more scopes
  than currently approved`

---

## Quick Summary

The agent messaging fails because the **web runtime's stored gateway device
token has insufficient OAuth-like operator scopes**. The gateway rejects the
connection before any agent run is created. The stream endpoint returns 404
because there is no active run to subscribe to — the route itself is fine.

---

## Full Request Flow (What Should Happen)

```
Browser
  └─ POST /api/chat  (message + sessionId)
       └─ apps/web/app/api/chat/route.ts
            └─ startRun(sessionId, message, ...) in apps/web/lib/active-runs.ts
                 └─ spawnAgentProcess() in apps/web/lib/agent-runner.ts
                      └─ GatewayProcessHandle.openAndAuthenticate()
                           └─ WebSocket → ws://127.0.0.1:19001
                                └─ gateway.request("connect", connectParams)
                                     └─ [IF OK] gateway.request("chat.send", ...)
                                          └─ events stream back → activeRuns registry

Browser
  └─ GET /api/chat/stream?sessionId=<uuid>
       └─ apps/web/app/api/chat/stream/route.ts
            └─ getActiveRun(sessionId) → must exist (created by POST above)
                 └─ streams SSE events to browser via subscribeToRun()
```

**When the gateway rejects `connect`:**
- `spawnAgentProcess` throws immediately
- `startRun` never registers an `ActiveRun`
- `GET /api/chat/stream` finds no run → returns `{ active: false }` with HTTP 404

---

## Root Cause: Scope Mismatch

### What the web runtime requests

Every time the web runtime connects to the gateway it requests these five
operator scopes (hardcoded in `buildConnectParams()`):

```typescript
// apps/web/lib/agent-runner.ts  line ~415
const scopes = [
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.read",
  "operator.write",
];
```

### What the stored device token has

The stored token at `~/.openclaw-dench/identity/device-auth.json` may only
have been approved with a subset of these scopes (e.g. just `operator.pairing`)
from a previous bootstrap run. When the web runtime sends all five scopes in
the `connect` RPC, the gateway sees new unapproved scopes and returns:

```
pairing required: device is asking for more scopes than currently approved
```

### Why this happens specifically on this repo

This fork adds `extensions/b2b-crm/` which registers additional agent tools.
New tools cause the gateway to re-evaluate the requesting device's scope set
on connection. An install that was working before adding the extension now
fails because the token was never upgraded.

---

## Verification Commands

Check what scopes the currently-approved device actually has:

```bash
openclaw --profile dench devices list
```

The output will show the `Paired` table. If `Scopes` shows only
`operator.pairing` (or any subset missing `operator.admin`, `operator.approvals`,
`operator.read`, `operator.write`) — this IS the problem.

Check whether `device-auth.json` exists and what scopes it stores:

```bash
cat ~/.openclaw-dench/identity/device-auth.json | python3 -m json.tool
# Look for .tokens.operator.scopes
```

---

## Files Involved

| File | Role |
|---|---|
| `apps/web/lib/agent-runner.ts` | Connects to gateway; `buildConnectParams()` defines the 5 required scopes; `loadDeviceAuth()` reads `device-auth.json`; `openAndAuthenticate()` runs the connect handshake |
| `apps/web/lib/active-runs.ts` | In-memory run registry; `startRun()` creates an entry; `getActiveRun()` is what the stream route queries |
| `apps/web/app/api/chat/route.ts` | POST handler; calls `startRun()`; returns 400/500 if it throws |
| `apps/web/app/api/chat/stream/route.ts` | GET SSE handler; calls `getActiveRun()`; returns 404 if run not found |
| `~/.openclaw-dench/identity/device-auth.json` | Persisted device token; `tokens.operator.scopes` is the approved scope list |
| `~/.openclaw-dench/identity/device.json` | Ed25519 keypair used for challenge-response signing |
| `src/cli/bootstrap-external.ts` | Bootstrap CLI; contains the self-healing scope-reset fix added in this fork |

---

## The Fix Already Applied in This Fork

`src/cli/bootstrap-external.ts` was extended with three pieces:

### 1. Scope constant (line ~81)

```typescript
const WEB_RUNTIME_OPERATOR_REQUIRED_SCOPES = [
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
  "operator.read",
  "operator.write",
] as const;
```

### 2. Helper functions (line ~89)

```typescript
function readDeviceAuthScopes(stateDir: string): string[] | null {
  // Reads ~/.openclaw-dench/identity/device-auth.json
  // Returns tokens.operator.scopes array, or null if file absent/invalid
}

function shouldResetDeviceAuth(stateDir: string): boolean {
  // Returns true if file exists but is missing any of the 5 required scopes
}
```

### 3. Pre-flight reset before web runtime starts (line ~3907)

```typescript
const didResetDeviceAuthForScopes = shouldResetDeviceAuth(stateDir);
if (didResetDeviceAuthForScopes) {
  postOnboardSpinner?.message("Resetting stale gateway device token (scope upgrade)…");
  try {
    rmSync(path.join(stateDir, "identity", "device-auth.json"), { force: true });
  } catch { /* ignore */ }
}
// ... then ensureManagedWebRuntime() starts the web server ...
// ... then attemptBootstrapDevicePairing() auto-approves the fresh request
```

When the file is deleted:
1. The web runtime starts without a stored token
2. It sends a fresh `connect` request asking for all 5 scopes → gateway creates a new pending device pairing request
3. `attemptBootstrapDevicePairing()` (already in the bootstrap flow) polls `openclaw devices list` and auto-approves the pending request
4. The web runtime's new token is written with all 5 scopes

---

## Why the Fix May Not Have Taken Effect Yet

The fix only runs when `pnpm dev` or `npx denchclaw update` (or `npx denchclaw`)
is executed. It does NOT patch a currently-running install. The fix is in the
compiled CLI (`dist/`), not in a running process.

**To apply the fix manually on a live install:**

```bash
# Step 1 — Delete the stale token
rm ~/.openclaw-dench/identity/device-auth.json

# Step 2 — Restart the web runtime so it sends a fresh pairing request
npx denchclaw restart   # or: pnpm dev (if running from source)

# Step 3 — Approve the new pairing request (may take 5–10 seconds to appear)
openclaw --profile dench devices list
openclaw --profile dench devices approve --latest

# Step 4 — Verify the new token has all 5 scopes
cat ~/.openclaw-dench/identity/device-auth.json | python3 -m json.tool
# tokens.operator.scopes should now be ["operator.admin","operator.approvals",
#   "operator.pairing","operator.read","operator.write"]
```

---

## Alternate Issue: Gateway Not Running

If the gateway itself is not running, the `connect` WebSocket will fail before
the scope check. Symptoms look similar (no active run → 404 on stream). Check:

```bash
openclaw --profile dench gateway status
# Should show: Listening: 127.0.0.1:19001

# If not running:
openclaw --profile dench gateway restart
```

---

## Alternate Issue: `device.json` Missing

If `~/.openclaw-dench/identity/device.json` is missing, the web runtime
connects without a device identity. The gateway may allow anonymous connections
with a minimal scope set that doesn't include the operator scopes needed to
call `chat.send`. Symptoms: same 404 loop.

Check:

```bash
ls ~/.openclaw-dench/identity/
# Should contain both: device.json  device-auth.json
```

If only `device.json` is missing, re-run bootstrap:

```bash
pnpm dev   # from source, or:
npx denchclaw
```

---

## Alternate Issue: Wrong `OPENCLAW_GATEWAY_PORT`

The web runtime reads `OPENCLAW_GATEWAY_PORT` from its environment (set at
launch by the bootstrap CLI). If this is wrong or unset, `resolveGatewayConnectionCandidates()`
in `agent-runner.ts` falls back to reading `~/.openclaw-dench/openclaw.json`
→ `gateway.port`. If that is also missing it uses `DEFAULT_GATEWAY_PORT = 18789`
(the OpenClaw default — wrong for DenchClaw which uses `19001`).

Check:

```bash
cat ~/.openclaw-dench/openclaw.json | python3 -m json.tool | grep port
# gateway.port should be 19001
```

---

## Key Code Paths for Deeper Investigation

### Where `connect` is called and errors are thrown

```
apps/web/lib/agent-runner.ts
  GatewayProcessHandle.openAndAuthenticate()   line ~888
    → loadDeviceIdentity(stateDir)             line ~227 (reads device.json)
    → loadDeviceAuth(stateDir)                 line ~250 (reads device-auth.json)
    → client.waitForChallenge()                line ~593
    → buildConnectParams(settings, {...})      line ~402
    → client.request("connect", connectParams) line ~913
    → if (!connectRes.ok) throw Error(...)     line ~914

  GatewayProcessHandle.beginStartMode()        line ~924
    → client.request("chat.send", {...})       line ~951
    → if (!startRes.ok) throw Error(...)       line ~971
```

### Where the error surfaces to the browser

```
apps/web/app/api/chat/route.ts
  POST handler
    → startRun(...)   -- throws if gateway connect fails
    → returns 500 with error message

apps/web/app/api/chat/stream/route.ts
  GET handler
    → getActiveRun(runKey)   -- returns undefined if no run was created
    → if (!run) return Response.json({ active: false }, { status: 404 })
```

### The `device-auth.json` schema

```json
{
  "deviceId": "abc123...",
  "tokens": {
    "operator": {
      "token": "...",
      "scopes": [
        "operator.admin",
        "operator.approvals",
        "operator.pairing",
        "operator.read",
        "operator.write"
      ]
    }
  }
}
```

---

## What a Working State Looks Like

After successful pairing with all 5 scopes:

1. `openclaw --profile dench devices list` shows the device in the **Paired** section with `Scopes: operator.admin, operator.approvals, operator.pairing, operator.read, operator.write`
2. `~/.openclaw-dench/identity/device-auth.json` has all 5 scopes in `tokens.operator.scopes`
3. `POST /api/chat` returns 200 and creates an active run
4. `GET /api/chat/stream?sessionId=<uuid>` returns 200 with `Content-Type: text/event-stream`
5. Chat messages appear in the UI

---

## What Has Already Been Tried / Changed

| Change | File | Outcome |
|---|---|---|
| Added `shouldResetDeviceAuth()` + pre-flight `device-auth.json` deletion | `src/cli/bootstrap-external.ts` | Self-heals scope mismatch on next `pnpm dev` / `npx denchclaw update`. Does NOT fix a currently-running install. |
| Documented `pairing required` in README troubleshooting | `README.md` | Documents manual fix steps |
| Confirmed gateway is running on port 19001 | `lsof -i :19001` | Gateway process is listening |
| Confirmed `devices list` shows only `operator.pairing` | `openclaw --profile dench devices list` | Confirmed root cause |

---

## Suggested Next Investigation Steps

If the fix in `bootstrap-external.ts` did not resolve the issue after running
`pnpm dev`:

1. **Check if `device-auth.json` was actually deleted and recreated** — look at
   the file's mtime vs when `pnpm dev` last ran.

2. **Check the web runtime startup log** — look for "Resetting stale gateway
   device token (scope upgrade)…" — if this message does NOT appear, the built
   `dist/` may be stale. Run `pnpm build` first.

3. **Check if `attemptBootstrapDevicePairing` approved the new request** — the
   bootstrap polls `devices list` looking for a pending request with
   `operator.read`, `operator.write`, `operator.pairing` scopes. If the gateway
   doesn't create a pending request within the poll window
   (`UNREADY_WEB_DEVICE_PAIRING_POLL_ATTEMPTS = 4` × `500ms`), approval is
   skipped silently.

4. **Manual approval as fallback** — delete `device-auth.json`, restart the web
   runtime, then immediately run `openclaw --profile dench devices approve --latest`.

5. **Check if `dangerouslyDisableDeviceAuth` is set** — if
   `gateway.controlUi.dangerouslyDisableDeviceAuth = true` is in
   `~/.openclaw-dench/openclaw.json`, the gateway skips device auth entirely,
   which would allow connection without any scopes. This is a security downgrade
   but useful for diagnosing whether the scope check is the only blocker.

   ```bash
   openclaw --profile dench config set gateway.controlUi.dangerouslyDisableDeviceAuth true
   openclaw --profile dench gateway restart
   # Test chat — if it works now, the scope check is confirmed as the sole blocker
   # REVERT afterwards:
   openclaw --profile dench config set gateway.controlUi.dangerouslyDisableDeviceAuth false
   openclaw --profile dench gateway restart
   ```
