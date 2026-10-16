# Verification and evidence boundaries

[← README](../README.md) · [Lifecycle and status](lifecycle.md) · [Safety and compatibility](safety-and-compatibility.md)

## Observed: 80-minute Codex coding workflow

On **2026-10-05**, the pre-publication OMP coding workflow ran for **80.0475 real minutes** using OMP CLI **18.5.1**, locally installed SDK **18.6.0** packages, and **`openai-codex/gpt-6.1-sol/high`**. Time was not accelerated or modified. No manual force-warming command was used.

This historical run is not a new live observation of the public release with published SDK **18.6.1** dependencies.

The result:

- **3 automatic cache-hit refreshes.** Every refresh reported actual cache reuse; branch and assistant-message IDs were unchanged before/after each one.
- **History unchanged by warming.** Hidden maintenance did not add session messages or extend the foreground response chain.
- **Successful resumed tool work.** Work resumed after roughly 50 minutes with **23,936 `cacheRead` tokens**; the final request reported **25,856 `cacheRead` tokens**. Real read/write/edit/bash tools and consumer CLI outcomes were exercised.
- **Estimated warm inference cost: `$0.008034`.** This is the extension's three-call ledger, not the workflow's total cost.

### Timing controls

| Refresh | Observed timing | Result |
| --- | --- | --- |
| First | 25.013 minutes since the foreground request | Actual cache hit; branch/assistant IDs unchanged |
| Second | 25.013 minutes since the foreground request | Actual cache hit; branch/assistant IDs unchanged |
| Third | 24.947 minutes after the second warm settlement; 50.023 minutes since foreground; 45.916 minutes since any observed non-warmer request | Actual cache hit; branch/assistant IDs unchanged; no native recap or intervening foreground request in this control |

These are measured intervals in the workflow, not a claim that every provider cache has a 50-minute lease. The third control isolates a long idle gap more clearly than a run with intervening foreground or native recap traffic.

### Foreground continuity

The workflow recorded **3 foreground turns**, **19 provider-request hooks**, **16 incremental attempts**, and **17 assistant completions**. OMP's native long-idle conversation chain transparently retried/fell back to a full request, then continued incremental work.

**Not all requests remained incremental.** The observation is successful resumed work with reported cache reuse—not flawless foreground chain persistence and not proof that Cache Control replaces OMP's recovery behavior.

The disposable transaction-summary exercise passed **5, then 6 workflow tests** as it developed. Those are tests of the coding task, **not the extension's regression count**. Its workspace and observation pane were cleaned up afterward; prompts, transcripts, user configuration, and credentials are not distributed in this repository.

### Cost boundary

The `$0.008034` value is the extension's **estimated inference warm cost for 3 calls**. It is separate from OMP's native footer and excludes foreground work, native recaps, unknown/unpriced costs, and cache-storage billing. It is not a savings estimate, invoice, subscription-quota measurement, or benchmark against disabling the extension.

## Observed: bounded Claude warm-up

The historical Claude case passed a **live bounded warm-up with `max_tokens: 1`**. This establishes a successful bounded live refresh in that tested case. It is **not** an equivalent 80-minute natural-soak result or new SDK 18.6.1 live proof, and it does not verify every Claude model or thinking configuration.

## Source-supported, not live-verified

The extension includes guarded adapters for several native API shapes and explicit Gemini/Vertex cached resources. The [compatibility document](safety-and-compatibility.md#api-adapters-are-not-live-compatibility-claims) describes their eligibility and refusal conditions.

Do not read adapter presence as a successful live test across all providers, models, credentials, endpoints, or modalities. In particular, **Antigravity Gemini is deliberately unavailable**, and no hidden warm calls are claimed for it.

## Regression checks are a different kind of proof

### Compiled OMP 18.8.7: observed local verification

The development SDKs now target **18.8.7**, with a reproducible upstream replay/abortable-reader bundle and static supported host imports. This change does not carry forward the 18.6.1 pass as an 18.8.7 result.

Required checks are `bun run build:cache-replay`, `bun run typecheck`, `bun run test`, and `bun run test:compiled` with the exact native compiled host on `PATH` or in `OMP_COMPILED_CLI`. The added [compiled-CLI E2E](../tests/compiled-cli.test.ts) launches isolated RPC mode with an empty profile, sends no prompt, and requires `/cache` advertisement without extension load failures. It rejects a source launcher and uses an explicit process-deadline flag.

On **2026-10-10**, Windows/Bun **1.4.2** passed helper generation, strict TypeScript checking, all **189 existing regressions / 1,448 assertions**, and the new compiled-CLI E2E against native OMP **18.8.7**. The regression suite retained its native-loopback privacy and consumer-cancellation cases. A separate isolated startup loaded the native-linked Cache Control together with twelve other active custom extension entries, advertised `/cache`, `/ysk`, and `/atlas`, and exited zero with empty stderr; no prompt or real credential was supplied. These checks are not new live-provider, native-TUI, or retention evidence.

### Durability recovery: 2026-10-11

On Windows/Bun **1.4.2**, the final regression suite passed **219 tests / 1,717 assertions**, including 30 new native-SDK recovery/provenance cases. Strict TypeScript checking also passed. The isolated compiled-CLI load E2E passed against the installed **18.8.9** binary; that establishes loading only, not full 18.8.9 compatibility. The development SDK remains pinned to **18.8.7**; the generated helper bundle was unchanged and was not rebuilt.

The new cases use the actual extension entrypoint and native SDK HTTP/SSE against loopback endpoints. They exercise bounded 429 retries and provider deadlines, instance-wide quota cooldowns, timeout/no-resend behavior, manual opt-out, cancellation, foreground exclusion, cadence floors, and auxiliary-request ownership. These endpoints return synthetic usage and incur no provider charges.

A separate real Windows native-TUI run used the pinned **18.8.7 source launcher**, an isolated temporary profile, and a loopback OpenAI-compatible endpoint. Before the fix, a background title request replaced the settled foreground snapshot and `/cache warm now` sent nothing. After the fix, the server observed a bounded hidden request returning HTTP 500, then—after a normal successful foreground request and **without** `/cache warm on`—a second bounded hidden request returning HTTP 200. Both hidden requests had an output cap of **1**; the TUI reported paused state after the first and a scheduled next refresh after the second. The CLI exited cleanly and the temporary server/profile were removed.

This proves native capture and recovery through the real terminal, not paid-provider retention or a natural idle soak. Distinct same-turn payloads before settlement deliberately remain unavailable until another eligible real turn.

### Paid natural Haiku soak: 2026-10-11

With explicit authorization for paid testing, the current source ran in the real Windows native TUI on pinned **OMP 18.8.7**, using **`anthropic/claude-haiku-4-5-20251001`** and short cache retention. No `/cache warm now`, accelerated clock, or paid-request retry was used. The corrected run completed two automatic refreshes over **541.482 seconds** from foreground capture to the second refresh's completion.

| Phase | Completed inference calls | Natural interval | Outcome | Estimated cost |
| --- | ---: | ---: | --- | ---: |
| Foreground, across both test runs | 4 | — | Completed, including resumed tool work | $0.024256 |
| Automatic refresh 1 | 1 | 270.454 s | Cache hit | $0.000721 |
| Automatic refresh 2 | 1 | 270.249 s | Cache hit | $0.000721 |
| Total | 6 | — | Within the approved $0.245130 conservative bound | $0.025698 |

Both refreshes transitioned from `warming` to the source-validated `warm` state and completed with priced ledger entries, proving positive cache reuse and accepted bounded output. Exact hidden cache-read/output token counts were not observable through the metadata-only observer. Counts come from completed foreground hooks/replies and the extension's successful warm ledger, not an independent HTTP wire counter; costs are native pricing estimates, not invoices.

The session leaf, branch length, and assistant-message IDs stayed unchanged after each hidden refresh. The resumed foreground request reported **7,130 cache-read tokens**, executed one native file read successfully, and returned the fixture's verified checksum **509500**. Its tool continuation also completed normally. No auxiliary inference or retry event was observed; temporary title, recap, and automatic retry settings were disabled.

The first test-only transport guard rejected a Request-form refresh before dispatch. That instrumentation failure was not a provider failure and incurred no warm charge; its completed initial foreground charge is included above. One explicitly approved restart removed that guard and retained all earlier cost evidence. No ambiguous paid request was replayed.

The existing credential was resolved read-only and injected through isolated in-memory native authentication, never placed in files, arguments, environment variables, or observation output. Warming was disabled after the two cycles, the native CLI shut down gracefully, and all 37 task-owned temporary files plus the observer/watcher were removed. Original configuration and credentials were unchanged; no deployment was performed.

This is a successful bounded natural soak for one provider/model/session, not an indefinite retention guarantee or a live verification of every adapter. Source SHA-256: `2cc9777a20abe5d894b113646acf99718344f9a5b56d3e502ec5fabb202c6eac`.

### Observed: ordinary Codex subscription soak, 2026-10-11

**Correction:** the earlier separately constructed model-discovery GET returned HTTP 401, but this did not establish that ordinary OMP inference was unavailable or that reauthentication was needed. Running OMP normally succeeded with its original native OAuth account routing and configured **`openai-codex/gpt-6-astra`**, without cloned credentials, a model-discovery gate, or API-key substitution.

The real Windows native TUI on **OMP 18.8.7** ran the same verified source. A cold foreground request completed successfully but correctly did not authorize warming. A genuine follow-up reported **18,816 cache-read tokens**, enabling the generic **240-second unknown-TTL cadence**. This is not Sol's 25-minute policy and does not establish Astra's backend TTL.

| Automatic refresh | Observed natural interval | Observed duration | Outcome | Native price estimate |
| --- | ---: | ---: | --- | ---: |
| 1 | 240.191 s | 2.680 s | Cache hit | $0.021114 |
| 2 | 241.245 s | 3.496 s | Cache hit | $0.019962 |

Both completed without `/cache warm now`, accelerated clocks, or retries. Timing comes from real-time native UI transitions, not independent wire timestamps. Source-validated `warming` → `warm` transitions establish positive usable cache reuse; exact hidden token counts were not observable. The leaf, branch length, and assistant-message IDs remained unchanged after each refresh.

After warming was disabled, resumed work reported **18,944 cache-read tokens**, performed one native file read, and returned the verified checksum **509500**. Its tool continuation completed successfully with **19,072 cache-read tokens**. The run completed six inference calls: four foreground/tool requests and two automatic refreshes, with no observed auxiliary inference or failed reply.

The native pricing estimate was **$0.300268 total**, including **$0.041076** for warming. These are SDK/catalog estimates, **not subscription charges or an invoice**. Actual subscription quota consumption and remaining limits were unavailable from this WebSocket run; no claim about their amounts is made.

The successful run used ordinary native authentication without manual token extraction or selection. A task-owned configuration overlay left the configured model/authentication and original profile configuration intact. The TUI exited gracefully, and temporary workspace, observer, overlay, watcher, and ownership-verified orphan processes were removed. No source changes or deployment occurred.

This supersedes the earlier blocked report and proves two natural subscription refreshes plus resumed real work on the configured Astra model. It does not prove indefinite retention or the separate Sol cadence. Source SHA-256: `2cc9777a20abe5d894b113646acf99718344f9a5b56d3e502ec5fabb202c6eac`.

### Published SDK 18.6.1: historical local verification

Local public-release verification passed **strict TypeScript checking and all 189 permanent tests** (1,448 expectations) against published OMP SDK **18.6.1** and Bun **1.4.2**. This is separate from the historical live observations above, not new provider-retention or native-TUI evidence.

The repository preserves the original tests in the **complete regression suite** at [tests/cache-control.test.ts](../tests/cache-control.test.ts). Controlled clocks, mocked provider calls, cache-management responses, and native SDK paths exercise correctness and refusal behavior. Unexpected paid provider calls are rejected by the harness.

Publication hardening checks target isolated, real local SDK paths without live provider credentials or endpoints:

1. Genuine native diagnostic-writer positive controls exposed hidden replay-prefix/body echoes before protection: OpenAI Completions numeric, string, and message-shaped HTTP 400/413 errors, Google `[DONE]` false completion, and a Bedrock unknown binary exception. After protection, native SSE/binary consumption regressions pass, including a valid cached binary response. Google/Vertex in-band errors and CLI nested-response/failed-finish cases are also covered; CLI has its own genuine writer positive control.
2. Native OpenAI HTTP 500-then-200 retry behavior must stop at **one actual inference send**, not just one payload-hook call.
3. Later in-place Google `cachedContent` additions, changes, and removals must use the final settled payload identity; an obsolete resource must not receive storage upkeep.
4. Successful SSE terminal markers close only the response transport, with response-local abort, zero read-ahead, and iterator return; they do not abort the whole warm job or discard successful accounting.

The complete suite also covers lifecycle isolation, cancellation, bounded output, cache misses, cadence/TTL interpretation, explicit-cache renewal, debug privacy guards, native-warmer interception, and verified Codex replay. These checks cannot establish a real provider's retention policy or long-idle behavior.

Run the local checks from [CONTRIBUTING.md](../CONTRIBUTING.md). The [Actions page](https://github.com/ubranch/omp-cache-control/actions) is the source of current public CI status; no CI or post-publication pass is claimed here. Controlled loopback regressions are not live-provider or native-TUI observations.

### Observed: native TUI with controlled Google loopback

A separate actual native-TUI smoke passed with published SDK **18.6.1**, Bun **1.4.2**, and an isolated home with no authentication or private configuration copied: a cold local Google provider sent nothing, then a genuine foreground SDK reply established eligibility using **synthetic local usage**, not paid-provider accounting.
The server received exactly **3 requests** (one foreground, two hidden warm requests), both warm caps were **1** and preserved the same full-prefix hash; a held-open `é`/`[DONE]` success cancelled its response transport before shutdown, the next HTTP-200 SSE 400 private-echo response stopped warming, and a third `warm now` while off sent nothing.
Session/leaf IDs, branch length/hash, the single assistant message, and foreground request/assistant event counts remained unchanged across warm success/failure/stop observations; the private canary appeared in **zero of two scanned native SDK log files**. This proves the controlled native-TUI path, not live-provider retention, real billing, or a natural idle soak.

## Observed versus inferred

| Statement | Evidence class |
| --- | --- |
| Three Codex warm-ups reported cache reads; resumed tool work succeeded | Observed in the historical real workflow above, not a new SDK 18.6.1 soak |
| Claude accepted a bounded 1-token live warm-up | Observed in that historical live case |
| `cacheRead` percentage describes reuse in the latest input accounting | Computed from reported request usage |
| Codex/Sol uses a 30-minute countdown estimate and 25-minute upkeep | Explicit inference/policy in the source, not a provider-issued lease |
| Unknown lifetime uses 4-minute maintenance | Inferred scheduling cadence, not an observed 4-minute TTL |
| An explicit Google resource has a verified future expiry | Identity from the final settled payload; metadata verified at runtime; renewal must prove a later expiry |
| Every adapter/provider will work, or a cache will always remain warm | **Not established and not promised** |

## Reproducing a live observation safely

A live soak is optional and can incur charges; it is not required for a contribution.

1. Use a disposable workspace and a supported native TUI with a real cacheable coding request. Record host/model/API versions and actual request usage.
2. Inspect `/cache warm` for eligibility, cadence, and cost. Leave automatic scheduling alone; do not alter the clock or use `warm now` if measuring natural idle behavior.
3. Record elapsed real-time intervals, any foreground/native recap traffic, cache-read accounting, and session/assistant IDs before and after each automatic refresh.
4. Resume actual tool work and confirm consumer behavior—not only an assistant's statement of success.
5. Report inference/storage/unpriced costs separately, redact sensitive data, and remove disposable workspace/observation artifacts.

No paid provider calls are needed for the ordinary regression suite or package-loading checks.
