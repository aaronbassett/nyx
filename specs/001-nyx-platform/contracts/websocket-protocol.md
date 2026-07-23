# Contract: WebSocket event protocol (D12)

One authenticated WSS connection per live project session (D40: last-tab-wins). All events are JSON `{ type, payload, ts }`; schemas live in `packages/protocol` (zod) and are the single source for both apps. Ordering: per-path file events are ordered (FR-019); events arriving during container mount/install queue and apply post-mount (EC-14).

## Server → client

| type | payload | client action | refs |
|---|---|---|---|
| `file:write` | `{ path, content }` | VFS write → HMR | FR-019 |
| `file:delete` | `{ path }` | VFS remove | FR-019 |
| `contract:deployed` | `{ address }` | write `VITE_CONTRACT_ADDRESS` → `.env.local`, restart dev server; emitted exactly once per deploy, post-finality | FR-055, D10 |
| `artifacts:ready` | `{ urlPrefix }` | re-point FetchZkConfigProvider; at most once per green turn | FR-014, D35 |
| `turn:activity` | `{ turnId, agent, phase, detail }` | activity-stream rendering (supervisor narration, sub-agent feed, cycle counts) | D20 |
| `turn:settled` | `{ turnId, consumed, balance }` | ledger UI update | FR-071 |
| `session:takeover` | `{ }` | this tab disconnected; show session-moved banner + take-back | D40 |
| `turn:message` | `{ turnId, role, delta }` | assistant reply / supervisor narration stream rendered in chat (distinct from the sub-agent feed) | D62, D20 |
| `deploy:status` | `{ requestId, phase: validating\|proving\|submitting\|awaiting_finality\|failed, detail? }` | deploy pipeline progress — deploys are not turns, so `turn:activity` never carries them | D62, FR-054 |
| `ledger:update` | `{ entry, available, reserved }` | live ledger propagation: deposit pending→credited, reserves, settlements | D62, FR-041, FR-071 |

## Client → server

| type | payload | purpose | refs |
|---|---|---|---|
| `prompt:submit` | `{ projectId, text }` | the chat input — THE entry point of every turn. Rejected with a named reason while a turn is active (FR-009/D24); classified before any reserve is placed (D25) | D62 |
| `test:results` | `{ turnId, pass, failures[] }` | behavioural verdict; parsed from structured Vitest output read via process streams (never in-container network) | FR-020, FR-028 |
| `console:log` / `console:error` | streamed, capped | runtime feedback within the turn | FR-007, FR-033 |
| `dev:status` | `{ state: booting\|ready\|crashed, phase?, detail? }` | boot pipeline + crash policy signals | FR-024, D39 |
| `deploy:request` | `{ }` | explicit deploy ask (user or user-instructed agent) | FR-054 |
| `file:changed` | `{ path, content }` | editor auto-save → immediate single-file commit; rejected during active turns (editor is read-only) | FR-047, D60 |

*Event set completed per D62 after the /sdd:analyze pass — the original D12 table presupposed the chat channel without defining it.*

## Reconnect contract (D38)

On reconnect the client GETs the manifest (paths + content hashes), diffs against the VFS, applies the difference. No sequence numbers, no replay. Convergence criterion: manifest hash equality (SC-010).

## Security invariants

No secret material ever crosses this channel (constitution III; SC-031). Payload caps enforced server-side; oversized file events rejected with named errors (EC-16).
