# Safety, cost, and compatibility

[← README](../README.md) · [Lifecycle and status](lifecycle.md) · [Verification](verification.md)

## Paid automatic maintenance is on by default

After a successful, eligible real request, an idle native TUI can send **paid hidden refresh requests** automatically. It is not just a display extension. To retain visibility without maintenance:

```text
/cache warm off
```

To hide status and suspend maintenance together:

```text
/cache off
```

The switches last for the current extension process. Reloading/restarting the extension starts with its defaults again. To stop it across future launches, uninstall the plugin. Closing the TUI stops its maintenance; there is no background service.

There is no promise of savings, perpetual warmth, account-quota preservation, or provider retention. A maintenance request can miss and still cost money. Aborting it cannot reverse a charge already incurred.

## What leaves the process

The extension holds the **actual foreground provider payload** and verified replay state in memory. It does not export OMP configuration, write its own prompt snapshots, or append warm messages to chat history. A hidden refresh nevertheless sends the eligible prefix to the current provider again, under that provider's existing data and billing policies.

Credentials and optional headers are freshly resolved for the live model. Requests are gated by session/model identity, idle state, pending messages, cancellation, and enablement. Codex diagnostic frames are cleared after wire serialization; the frame is not a saved transcript.

If `PI_REQ_DEBUG=1`, hidden warming stops rather than letting native request-body diagnostics persist private prompts. Request-local guards intercept HTTP failures, supported SSE in-band errors, malformed events, refusals, and failed terminal states before native SDK diagnostics can persist the hidden replay prefix; sanitized error metadata may still be logged. Bedrock binary events use the public Smithy codec to validate framing/CRC and neutralize errors/exceptions before SDK consumption while preserving valid response bytes. Foreground logging and transport are unchanged; these controls are not a general log scrubber.

The replay snapshot is committed after the foreground request settles, including later **in-place** payload-hook edits. A later extension that **replaces the whole body** cannot be observed reliably; load Cache Control after payload-transforming extensions. See [extension ordering](lifecycle.md#troubleshooting).

## Bounded does not mean free

Refreshes preserve cache-affecting prompt fields rather than removing tools, thinking, or modalities just to make a request pass. Where a cache-safe bounded request cannot be constructed, the extension reports **unavailable** instead.

- Codex uses an isolated native WebSocket, a small hidden reply instruction, and a 16-token cap. The GPT-6 family gets a low-effort configuration update for this hidden request. HTTP fallback and automatic retries are refused.
- Anthropic/Bedrock use a 1-token native output cap. Anthropic's streaming endpoint rejects `max_tokens: 0`, so zero is not used.
- OpenAI Responses/Azure use 16 tokens. OpenAI Completions uses 1 token, or 16 for reasoning-enabled requests. Tool definitions remain present; `tool_choice: none` prevents execution without dropping cached definitions.
- Google/Ollama inference adapters use a 1-token native cap. Unsafe Google tools or non-text generation are refused.
- Explicit Google cached resources use verified expiry renewal, not a hidden generated reply. Those renewals can charge **cache storage**.

Each hidden inference refresh permits **at most one actual inference send**, not merely one payload construction. Native transport retries are refused before a second send; authentication and cache-metadata requests are not inference sends.

The response must also prove bounded, usable completion. Unexpected tool/image output, oversized text, invalid usage, or a failed transport stops warming. There is no retry-and-bill loop.

Successful SSE terminal markers close only that response transport, not the whole warm job, preserving completion and usage accounting. Response-local abort, zero read-ahead, and explicit iterator return prevent continued consumption after completion.

## Cost accounting

`/cache warm` reports the extension's own ledger:

- **Calls:** maintenance inference attempts actually sent plus explicit-cache renewal attempts. Eligibility checks and cache-metadata GETs are not paid inference calls in this ledger.
- **Estimated inference cost:** finite, nonnegative provider/SDK-reported `usage.cost.total` values that can be priced. This is not an invoice or subscription-quota meter.
- **Unpriced calls:** attempts for which a reliable inference price was not obtained. These are not free calls.
- **Explicit cache renewals:** counted separately in the status note; storage pricing is not calculated by the inference-cost total.

The ledger is process-local and separate from OMP's native footer. It excludes foreground work, native recap/other host requests, unknown prices, and storage charges. A failed or cancelled attempt can remain unpriced. See the [observed Codex ledger](verification.md#cost-boundary).

## API adapters are not live compatibility claims

Eligibility is decided from the **actual API and payload**, not a provider's marketing name. Except where [verification](verification.md) says otherwise, the following are source-supported conditions, not live-tested provider/model combinations.

### Codex Responses — `openai-codex-responses`

Requires the native WebSocket transport and a full matching request or a verified matching foreground delta. Restart/resume, mismatched response references, or unproven native output wait for another full real request. Warming never adds to the foreground response chain.

The measured model is `openai-codex/gpt-6.1-sol/high`. Its special cadence is 25 minutes with an inferred 30-minute retention estimate, and it requires at least 1,024 input/cache-accounted tokens. That rule and the natural-soak result are not evidence for every Codex model.

### Anthropic and Bedrock — `anthropic-messages`, `bedrock-converse-stream`

Require a matching replayable request, usable token accounting, and cache eligibility. Native ephemeral/cache-point markers and model cache metadata can determine the short/long estimate.

**Budget-based thinking (`type: enabled`) is unavailable:** lowering its output budget would not preserve the captured prefix safely. A bounded Claude live warm-up succeeded; Bedrock and every Claude thinking/model configuration are not thereby live-verified.

### OpenAI and Azure — `openai-responses`, `azure-openai-responses`, `openai-completions`

Require full replayable context, usable token accounting, and declared or observed cache capability. Tools remain defined but disabled for execution. Non-Codex `previous_response_id` input cannot be reconstructed and waits for a full request.

Responses/Azure **linked server conversations are unavailable** because hidden requests would append turns to that conversation. A stateless full-context request is required. An OpenAI-compatible endpoint sharing an API shape does not automatically prove cache retention, prices, or safe live behavior.

### Google — `google-generative-ai`, `google-vertex`, `google-gemini-cli`

For inference refreshes, require safe text output, a matching prefix, and cache eligibility. Function declarations can remain in the prefix, but server-side tools or unknown tool structures cannot be disabled cache-safely and are unavailable. Non-`TEXT` response modalities and observed generated images are unavailable.

For explicit Gemini/Vertex `cachedContent`, identity is derived and validated from the **final settled foreground payload**. Later in-place additions, changes, or removals determine whether upkeep renews an explicit resource or uses eligible inference; an earlier copied identity cannot authorize storage maintenance.

The extension verifies the native resource identity, model, lease metadata, and future expiry. It renews the **existing** lease near its fixed deadline. It does not create an explicit cache resource for you. Invalid identities, short/expired leases, or an unproved later expiry stop warming. Cache-storage charges remain outside the inference estimate.

**Antigravity Gemini is deliberately unavailable.** No hidden warm calls are sent through an unverified Antigravity path. The `google-gemini-cli` adapter is not a general claim of Antigravity compatibility.

### Ollama — `ollama-chat`

The native local Ollama case can be eligible without the remote 1,024-token/cache-capability gate. A non-native endpoint using this API shape still needs ordinary cache eligibility.

The extension preserves `keep_alive`. Positive numeric or Go-style duration values can shorten the maintenance schedule; zero residency is unavailable, and a feasible interval shorter than the one-second managed scheduler is unavailable. Negative/infinite residency does not establish a prompt-cache TTL. Model residency is not a KV-cache guarantee. No equivalent live natural-soak result is claimed.

## Shared eligibility and deliberate refusal

For non-local APIs other than the measured Codex special case, a small request below 1,024 input/cache-accounted tokens needs reported cache reads/writes to become eligible. Other requests still need declared cache capability or observed cache usage. Unknown lifetime is handled with inferred 4-minute upkeep, not a fabricated 4-minute TTL.

An unknown API, mismatched model, non-replayable payload, unsafe thinking/tools/modalities, invalid lifetime, pending user work, or unavailable auth cannot authorize paid warming. `/cache warm now` does not bypass these checks.

Providers can change behavior, drop usage fields, bill differently, or evict a prefix early. Check actual request accounting and the current `/cache warm` reason instead of treating a compatibility list or timer as a guarantee.
