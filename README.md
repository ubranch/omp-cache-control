<div align="center">

<img src="./assets/readme/hero.svg" width="100%"
     alt="cache control, an omp extension: see real prompt-cache reuse and refresh eligible idle prefixes. Illustrated /cache warm example with a historical three-call ledger; paid upkeep starts on, hidden replies stay outside chat history, and retention is not guaranteed.">

<p>
<img src="https://img.shields.io/badge/typescript-1E1E22?style=flat-square" alt="TypeScript">
<img src="https://img.shields.io/badge/omp_18.6-1E1E22?style=flat-square" alt="Tested against omp SDK 18.6.1">
<img src="https://img.shields.io/badge/1_runtime_dep-1E1E22?style=flat-square" alt="1 runtime dependency: @smithy/core">
<img src="https://img.shields.io/badge/189_tests-1E1E22?style=flat-square" alt="189 permanent tests">
<a href="#install"><img src="https://img.shields.io/badge/install-F97316?style=flat-square&labelColor=1E1E22" alt="Install"></a>
</p>

</div>

**Cache Control** is an omp extension that shows how much of your latest request the provider read from a prompt cache. While the native TUI is idle, it can refresh an eligible prefix without adding messages to your chat history.

**Status and paid automatic warming start on. Provider retention is not guaranteed.**

## install

Use omp's native GitHub plugin installer:

```sh
omp plugin install github:ubranch/omp-cache-control
```

1. **Fully exit and restart omp.** Plugins load at process startup; `/reload-plugins` does not reload TypeScript extensions.
2. Open `/settings` (or **Ctrl+,**) → **Appearance → Status Line**. Set **Status Line Preset** to `custom`; add `status` to **Left Segments** without removing your existing segments. Stock presets omit extension status.
3. Complete a real, cacheable coding request. Run `/cache warm` to inspect eligibility, schedule, call count, and estimated cost.

For visibility without paid upkeep, run `/cache warm off`. This lasts only for the current process; a fresh extension load starts with the defaults. [Uninstalling](#reference) is the persistent opt-out.

## look

The status shows **cache-read percentage for the latest matching assistant request**, an estimated countdown or unknown TTL, and the warm state. The percentage is **not account quota**. A `~` timer is an estimate, not a retention guarantee.

Illustrated `/cache warm` output, line-wrapped for readability. The three-call cost comes from the historical ledger below; the countdown is an example, not a recorded or current provider state.

```text
/cache warm
Cache warm next in 24:37; 3 calls;
estimated inference warm cost $0.008034
```

> **Historical live result · 2026-10-05:** 80.0475 real minutes, 3 automatic cache-hit refreshes, and unchanged history. Tool work resumed after roughly 50 minutes with **23,936 `cacheRead` tokens**; the final request reported **25,856**. The three-call warm inference estimate was **$0.008034**, not the workflow's total cost.

[Evidence, timing controls, and version boundaries](docs/verification.md) · [Full caveats](#reference)

## how it works

<img src="./assets/readme/lifecycle.svg" width="100%"
     alt="Capture a successful real foreground request. While the native TUI is idle, refresh the eligible prefix with paid, bounded, isolated maintenance. Real work cancels maintenance. Warm replies stay outside chat history; provider retention is not guaranteed.">

1. A **fresh, successful foreground request** supplies the actual provider payload and usable accounting. Restored history alone cannot authorize warming.
2. While the native TUI is idle, the extension can refresh that eligible prefix through a **separate, guarded, bounded request**. Explicit Google cached resources use verified lease renewal instead of an inference reply.
3. Real user work cancels maintenance. Warm replies do not become session messages or extend the foreground response chain; cache-affecting prefix fields are preserved.

Only reported cache reuse advances the estimated warm anchor. A miss keeps the normal cadence but makes expiry unknown. There is no promise of retained provider storage.

[Full lifecycle, cancellation, ordering, and native-warmer interception](docs/lifecycle.md)

## commands

`/cache warm` explains the current warm state. `/cache warm off` keeps visibility without paid upkeep.

<details>
<summary><b>all seven commands and process-local switches</b></summary>

<br>

| Command | What it does |
| :-- | :-- |
| `/cache` | Enable status and its timer; preserve the warming switch. |
| `/cache on` | Enable status and its timer; does not undo `warm off`. |
| `/cache off` | Hide status, stop its timer, and cancel/suspend maintenance; preserve the warming switch. |
| `/cache warm` | Show warm state, schedule, call count, estimated inference cost, and unpriced calls. Does not force a refresh. |
| `/cache warm on` | Re-enable paid automatic upkeep for an eligible snapshot; status must also be enabled. |
| `/cache warm off` | Disable/cancel paid upkeep; keep visibility. |
| `/cache warm now` | Attempt a paid refresh now, only if idle and eligible. Does not bypass off or safety guards. |

Switches last for the current extension process and are not saved preferences. A fresh extension load starts with both on. To re-enable both explicitly, use `/cache on` followed by `/cache warm on`.

`/cache warm now` cannot send before a usable real request, while queued work remains, or through an unsafe/unsupported API. For an explicit cache resource, it can force renewal before the normal deadline and incur storage charges.

[Status meanings and failure recovery](docs/lifecycle.md#reading-the-status)

</details>

## reference

<details>
<summary><b>status, inferred timers, and warm cost</b></summary>

<br>

Cache-read percentage is `cacheRead / (input + cacheRead + cacheWrite)` for the latest matching assistant request, rounded to a percentage. It is **not account quota, remaining subscription, session-wide hit rate, or percentage savings**.

A **`~` countdown is inferred**, not a provider-issued retention guarantee:

- **`openai-codex/gpt-6.1-sol` only:** an inferred 30-minute retention estimate and a 25-minute upkeep policy. Neither is a backend lease.
- **Unknown lifetime:** inferred 4-minute upkeep, **not a claimed 4-minute TTL**.
- **Explicit Google cached resources:** expiry is checked separately and verified lease renewal is used. **Ollama residency is not a KV-cache lease.**

The warm ledger is **process-local** and separate from omp's native footer. Unpriced calls are not free calls. Cache-storage renewal can be billed outside the inference estimate; cancelled requests may still be billable.

[Timer policy and status states](docs/lifecycle.md#what-the-timer-means) · [Cost accounting](docs/safety-and-compatibility.md#cost-accounting)

</details>

<details>
<summary><b>adapters, payload ordering, and privacy guards</b></summary>

<br>

Guarded adapters cover Codex, Anthropic/Bedrock, OpenAI/Azure, safe Google API cases and explicit cached resources, and Ollama. Eligibility depends on the actual native payload, cache capability/usage, usable accounting, and safe bounded output. Source support is not universal live verification.

**Antigravity Gemini is deliberately unavailable.** Budget-based thinking, linked server conversations, unsafe server tools, and non-text generation can also be unavailable rather than silently rewriting a cache prefix.

Load Cache Control **after payload-transforming extensions**. Later in-place edits are captured at settlement, but later whole-body replacement is not observable through the public hook; ordering alone does not make that compatible.

**`PI_REQ_DEBUG=1` stops hidden warming** to avoid native diagnostics persisting private warm prompts. Remove the setting and manually re-enable warming afterward. This does not make foreground logging safe.

[Exact API conditions, refusal cases, and privacy boundaries](docs/safety-and-compatibility.md)

</details>

<details>
<summary><b>historical evidence and version boundaries</b></summary>

<br>

The **2026-10-05** real coding workflow used OMP CLI **18.5.1**, locally installed SDK **18.6.0** packages, and **`openai-codex/gpt-6.1-sol/high`**. It is **not a new live observation of the public release with SDK 18.6.1**.

- **80.0475 real minutes; 3 automatic cache-hit refreshes.** No modified clock or manual force warming. Branch and assistant-message IDs stayed unchanged after each refresh; hidden replies did not add history or extend the foreground chain.
- **Resumed tool work after roughly 50 minutes:** 23,936 `cacheRead` tokens on resume and 25,856 on the final request, with real read/write/edit/bash tools and successful consumer CLI outcomes.
- **$0.008034 estimated inference warm cost for 3 calls.** Separate from the native footer; excludes foreground work, native recaps, unknown/unpriced costs, and cache-storage billing. It is not an invoice, savings estimate, quota measurement, or benchmark against disabling the extension.

Claude also passed a **live bounded warm-up with `max_tokens: 1`**, not an equivalent 80-minute soak or new SDK 18.6.1 live proof. Other adapters are source-supported under guards, not universally live-tested.

omp's long-idle foreground chain did retry/fall back to full context before continuing. Not all requests stayed incremental.

The **189-test** badge refers to the public-release regression suite against SDK **18.6.1**, not new live-provider retention evidence.

[Full evidence, controls, local verification, and what this does not prove](docs/verification.md)

</details>

<details>
<summary><b>upgrade, uninstall, and native maintenance policy</b></summary>

<br>

Upgrade the installed plugin from its recorded GitHub source:

```sh
omp plugin upgrade omp-cache-control
```

**Fully exit and restart omp afterward.** The native action is `upgrade`, not `update`. Linked development checkouts cannot be upgraded this way; edit/pull the checkout and restart instead.

To remove it:

```sh
omp plugin uninstall omp-cache-control
```

**Fully exit and restart omp afterward.** Uninstalling is the persistent opt-out; process-local commands do not save preferences.

While loaded in the native TUI, this extension stops omp's own warmer—even when `/cache off` or `/cache warm off` is active—to prevent two maintenance policies from racing or billing simultaneously. Removing the extension returns control to **omp's native policy**, which may have separate settings. Non-TUI modes are not intercepted.

</details>

## limits

- Maintenance runs only in an **open native TUI**, not a background daemon or headless mode. No fresh successful foreground capture means no provider warm call.
- Providers own retention. A timer or cache miss is not evidence that a prefix remains cached; only reported usage demonstrates reuse.
- Paid upkeep starts on, and an already-sent or cancelled request can still cost money. The process-local ledger is not your total bill.
- Compatibility is conditional. Unsafe or unsupported payloads are refused, not silently rewritten; see the adapter and privacy reference above.

## troubleshooting

- **No status:** enable the custom layout's `status` segment and run `/cache on`. Symbol style follows **Settings → Appearance → Theme → Symbol Preset**.
- **Pending or unavailable:** finish a real cacheable request and queued work; `/cache warm` reports the current reason. Restored history alone cannot authorize warming.
- **Stopped after a failure:** fix the reported cause, then `/cache warm on`. A miss does not prove a refreshed cache, and a cancelled request may still be billable.

[Full troubleshooting](docs/lifecycle.md#troubleshooting)

## development

Normal runtime uses **the host's SDK first**; no extension-local SDK repair is needed. The one production dependency, **`@smithy/core`**, supplies the public Smithy Bedrock codec, not a bundled omp SDK.

Development targets **OMP 18.6.1 SDKs** and **Bun ≥ 1.3.14**. The lowest compatible OMP host version is not established.

[Contributing and release procedure](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [CI](https://github.com/ubranch/omp-cache-control/actions) · [Releases](https://github.com/ubranch/omp-cache-control/releases)

[Report a sanitized bug](https://github.com/ubranch/omp-cache-control/issues) · [Report a vulnerability privately](SECURITY.md)

**MIT** — [License](LICENSE). Distributed through the native GitHub plugin reference; no npm listing is claimed.
