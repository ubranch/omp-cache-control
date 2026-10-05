# Lifecycle and status

[← README](../README.md) · [Safety and compatibility](safety-and-compatibility.md) · [Verification](verification.md)

## A real request comes first

<p>
  <img src="../assets/readme/lifecycle.svg" width="100%" alt="Capture a real request, refresh its eligible prefix only while idle, then resume normal tool work; refreshes do not enter chat history.">
</p>

1. **Capture:** a successful foreground request supplies the actual provider payload and usable token accounting.
2. **Refresh:** while the native TUI is idle, an eligible in-memory snapshot is refreshed through a separate bounded request, or an explicit Google cache lease is renewed.
3. **Resume:** real user work takes priority. Hidden replies do not become session messages or extend the foreground response chain.

This is maintenance of an eligible prefix, not a promise that a provider will retain it. See [what the timer means](#what-the-timer-means).

## Defaults and commands

Both display and automatic warming start **on** when the extension loads. These switches are process-local, not saved preferences. `/cache warm off` is the explicit paid-refresh opt-out for the current process.

| Command | Effect |
| --- | --- |
| `/cache` | Enable the display, read the current branch's latest assistant usage, and start the status timer. Preserve the warming switch. |
| `/cache on` | Same as `/cache`; it does not undo `/cache warm off`. |
| `/cache off` | Hide status, stop its timer, and cancel/suspend warming. Preserve the warming switch. |
| `/cache warm` | Show warm state, next eligible schedule, call count, estimated inference cost, and any unpriced calls. Does not force a refresh. |
| `/cache warm on` | Re-enable paid automatic warming and reschedule an eligible snapshot. The display must also be enabled. |
| `/cache warm off` | Disable paid warming and cancel an active refresh; keep cache visibility enabled. |
| `/cache warm now` | Attempt a paid refresh immediately when idle. All eligibility, safety, enablement, and shutdown guards still apply. |

`/cache warm now` is not an override. It cannot warm before a usable real request, while queued messages remain, with warming disabled, or through an unsupported/unsafe API. It can force an explicit-cache renewal before its normal deadline, which can incur storage charges.

## Event-by-event behavior

### Start, restart, and resume

- Start with no replayable snapshot and no verified Codex chain. A saved assistant message can populate status, but cannot authorize warming.
- Complete a fresh, successful real request before maintenance is scheduled. Resume/restart does not change OMP's foreground chaining configuration.
- Warming requires an open **native TUI** with UI support. There is no background daemon, startup paid request, or headless refresh loop.
- The status uses OMP's managed one-second timer; it is not a second polling service. The warmer's call/cost ledger lasts for this extension process and is not reset when changing branches or sessions.

### Session, model, and branch changes

Session switch, branch, tree navigation, and compaction cancel active maintenance, clear the snapshot and verified chain, and reseed the display from the selected branch. A new real request is required.

The current model is checked on timer ticks and at request boundaries. A change of session/model identity invalidates captured state. A delayed refresh never reuses a previous model's credentials: API keys and optional transport headers are resolved again for the live model before sending.

### User turns and tool continuations

`before_agent_start` cancels any refresh and marks foreground work active. Every foreground provider request replaces the candidate snapshot; earlier tool-step payloads do not become the final idle prefix.

The awaited `assistant_message` hook settles the matching request before another tool continuation can run. Only a successful, matching reply with finite, nonnegative input/cache accounting can authorize the snapshot. Errors and aborted foreground replies do not schedule it. `agent_end` releases the foreground gate; unfinished Codex settlement discards its candidate.

A timer deadline alone cannot send a request. The extension also requires the session to be idle, no queued messages, unchanged identity, an eligible snapshot, no active maintenance, and both switches enabled.

### Codex foreground chains

A full native wire request can seed the verified chain. A later delta is accepted only when its `previous_response_id` exactly matches the last verified foreground reply. The extension expands it from that foreground input plus native, replay-safe output—not from reconstructed chat history. Unproven or partially dropped output cannot authorize the next delta.

The final wire body is frozen after in-place payload-hook edits. Warm requests use an isolated WebSocket connection, remove the foreground response reference, retain cache-affecting fields, and append only a tiny hidden reply instruction. They never extend the real response chain. HTTP fallback and automatic warm retries are refused.

If OMP itself must recover a long-idle foreground chain by retrying or falling back to a full request, it remains OMP's behavior. Cache Control does not promise that all foreground requests stay incremental.

### Completion, misses, and failures

A bounded completed refresh is accepted only with usable cache-token accounting and a matching provider/model. Tool calls, images, oversized output, unusable accounting, unexpected completion, or a second send are refused. A refresh has a 45-second timeout and its isolated transport state is closed afterward.

- **Cache hit:** reported `cacheRead > 0` refreshes the estimated timing anchor and schedules the next upkeep.
- **Cache miss:** show `warm miss`, make expiry unknown, and keep the ordinary cadence. Do not claim the prefix was refreshed. A later scheduled hit restores the estimate.
- **Failure:** stop automatic warming for this process and notify with the reason. There is no hidden retry loop. Already-sent requests may still be billable.

Fix the reported cause, complete another real request if the snapshot was invalidated, then use `/cache warm on`. Use `/cache on` too if the display was disabled. Re-enabling does not bypass an unsafe or unsupported request.

### Cancellation and shutdown

User work, manual off commands, context changes, and shutdown cancel maintenance through an abort controller and revision/identity checks. Async completions from old work cannot install a new deadline or chain. Cancellation cannot undo provider work or charges already incurred.

Shutdown clears the snapshot/chain/status, stops the timer, and closes active maintenance. It does not create a saved warm state to resume later.

### Native warmer interception

While this extension is loaded in the native TUI, its `cache_warming_decision` handler returns `stop` for OMP's own warmer—even when `/cache off` or `/cache warm off` is active. This prevents two maintenance policies from racing or billing simultaneously. Non-TUI modes are not intercepted. Removing the extension returns control to OMP's native policy; an opt-out here is not a permanent global OMP setting.

## What the timer means

A `~` countdown is an **estimate**, never a server TTL or eviction guarantee. The provider owns retention. The conservative timing anchor begins at the foreground request's start; only reported cache reuse advances the warm anchor.

| Case | Scheduling and display |
| --- | --- |
| `openai-codex/gpt-6.1-sol` | A 25-minute upkeep cadence with an explicitly inferred 30-minute retention window. Neither is a backend lease. |
| Native cache markers or model metadata | Use a single unambiguous short/long TTL where available. Maintenance targets 90% of that interval, reserving a 10-second margin for intervals over 10 seconds. |
| Cache capability/use, but unknown TTL | Infer a **4-minute upkeep interval**. Display TTL as unknown; 4 minutes is not a claimed cache lifetime. |
| Ollama `keep_alive` | Preserve native residency policy and shorten cadence if needed. Residency is not a KV-cache lease; TTL can remain unknown. Zero residency or a sub-one-second feasible cadence is unavailable. |
| Explicit Gemini/Vertex cached resource | Query and verify the resource's fixed expiry, then renew its lease near the deadline. Foreground reads do not postpone it. Metadata GETs do not renew it; renewal PATCHes can bill storage. |

Mixed short/long markers can leave TTL ambiguous. Where `promptCache` metadata exists, those declared durations inform the estimate; they are not evidence of guaranteed retention for the current prefix.

## Reading the status

The Custom status segment shows the latest matching assistant request's reuse percentage, an estimated countdown or unknown TTL, and the warm state. It is not an account dashboard.

- **Reuse percentage:** `round(cacheRead / (input + cacheRead + cacheWrite) × 100)`. It describes the latest request's input accounting—not account quota, remaining subscription, dollar savings, or an aggregate session hit rate.
- **`pending`:** no usable matching assistant usage yet, or the selected model differs from the displayed reply.
- **`warm pending` / `warm` / `warming`:** eligible upkeep is waiting, a successful warm timing anchor exists, or a request is currently active.
- **`warm miss`:** maintenance completed without reported cache reuse; estimated expiry is unknown.
- **`warm off` / `warm unavailable` / `lease`:** warming is disabled, guards reject the current request, or an explicit cache resource is being maintained.

`/cache warm` gives the reason and schedule in text, so the status is not the only diagnostic channel. Its cost ledger is separate from OMP's native footer; see [cost accounting](safety-and-compatibility.md#cost-accounting).

## Troubleshooting

**No cache status appears**  
Open `/settings` (or **Ctrl+,**) → **Appearance → Status Line**. Set **Status Line Preset** to `custom`; include `status` in **Left Segments** without replacing existing segments. Stock presets omit extension status. Check `/cache on`, complete a request on the selected model, and inspect `/cache warm`. Under **Appearance → Theme → Symbol Preset**, choose `unicode`, `nerd`, or `ascii` for the host's symbol style.

**Warm pending never becomes scheduled**  
Wait for a successful, sufficiently large/cacheable real request. Resumed history alone is insufficient. Finish queued messages and foreground tool work. `/cache warm` reports whether you are waiting for a prefix or the API is unavailable.

**Warm state is off after an error**  
Read the notification or `/cache warm` reason. Resolve authentication/transport/provider issues first, then `/cache warm on`. Do not repeatedly force paid requests as a diagnostic substitute.

**The timer expired, or a refresh missed**  
Providers can evict caches early. A countdown is not proof of retained storage; a cache miss deliberately removes the estimate. Real request usage is the evidence of reuse.

**Another extension rewrites provider payloads**  
Load Cache Control **after** payload-transforming extensions. Later in-place edits are captured at settlement, but a later whole-body replacement is invisible to the public hook. Do not rely on ordering alone to make a whole-body-replacing extension compatible.

**Request-body debugging is enabled**  
`PI_REQ_DEBUG=1` suspends hidden warming and requires manual re-enable after the setting is removed. This guard prevents native diagnostics from persisting private warm prompts. It does not make foreground logging safe; review the host's logging policy separately.
