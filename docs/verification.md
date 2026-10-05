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

### Published SDK 18.6.1: local verification

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
