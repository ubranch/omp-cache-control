# Changelog

## 1.0.0 — 2026-10-05

Initial standalone distribution of the existing OMP Cache Control extension.

- **Native plugin packaging:** `omp.extensions` entry point, host-resolved runtime SDKs, portable development dependencies, MIT license, and CI for type checking and the complete regression suite, including the preserved original tests.
- **Cache visibility and controls:** Custom status-line reuse percentage and estimated/unknown expiry; `/cache [on|off]` and `/cache warm [on|off|now]`; separate process-local estimated warm-cost ledger. Paid automatic idle maintenance is enabled by default.
- **Guarded maintenance:** native bounded adapters for eligible API payloads, verified isolated Codex replay, explicit Gemini/Vertex cache-lease renewal, and Ollama residency-aware cadence. Antigravity remains deliberately unavailable; unsafe budget thinking, linked conversations, tools, and non-text output are refused.
- **Lifecycle and privacy safeguards:** real-request gating, model/session/branch invalidation, foreground priority, cancellation and shutdown cleanup, miss-aware estimates, stop-on-failure behavior, native-warmer interception, and a request-body debug guard. Warm replies do not enter chat history.
- **Publication hardening:** request-local HTTP/SSE in-band, parse, refusal, failed-terminal, and Bedrock binary privacy guards before native SDK diagnostics, without changing foreground diagnostics; public Smithy framing/CRC codec as a normal production dependency. Successful SSE cleanup closes only the response transport, preserving warm completion/accounting. One actual hidden inference send even when the native transport would retry; explicit-cache identity validated from the final settled payload, including later in-place hooks. Whole-body replacement still requires extension ordering.
- **Documentation and evidence:** installation/removal, lifecycle/safety/compatibility guidance, contribution/security reporting, static accessible README visuals, and historical 80-minute Codex and bounded Claude observations distinguished from strict TypeScript and all 189 permanent tests passing with published SDK 18.6.1/Bun 1.4.2. Controlled native SDK loopback regressions use genuine diagnostic-writer positive controls; they are not new live-provider or native-TUI proof.
