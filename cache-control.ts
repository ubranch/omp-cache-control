import { dirname } from "node:path";
import { EventStreamCodec, getChunkedStream } from "@smithy/core/event-streams";
import type { AssistantMessage, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import type * as AiSDK from "@oh-my-pi/pi-ai";
import type * as ErrorsSDK from "@oh-my-pi/pi-ai/error";
import type * as ResponsesSDK from "@oh-my-pi/pi-ai/utils";
import type * as GoogleAuthSDK from "@oh-my-pi/pi-ai/providers/google-auth";
import type * as CatalogHostsSDK from "@oh-my-pi/pi-catalog/hosts";
import type * as StreamsSDK from "@oh-my-pi/pi-utils/stream";
import type * as AbortableSDK from "@oh-my-pi/pi-utils/abortable";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Resolve import-only SDK exports beside the running OMP, not a fixed-install junction.
// The local base also supports standalone development with published SDK packages.
function sdkPath(specifier: string): string {
	if (process.argv[1]) {
		try { return Bun.resolveSync(specifier, dirname(process.argv[1])); } catch { /* Try local development dependencies. */ }
	}
	return Bun.resolveSync(specifier, import.meta.dir);
}
const [ai, errors, responses, googleAuth, catalogHosts, streams, abortables] = await Promise.all([
	import(sdkPath("@oh-my-pi/pi-ai")) as Promise<typeof AiSDK>,
	import(sdkPath("@oh-my-pi/pi-ai/error")) as Promise<typeof ErrorsSDK>,
	import(sdkPath("@oh-my-pi/pi-ai/utils.js")) as Promise<typeof ResponsesSDK>,
	import(sdkPath("@oh-my-pi/pi-ai/providers/google-auth")) as Promise<typeof GoogleAuthSDK>,
	import(sdkPath("@oh-my-pi/pi-catalog/hosts")) as Promise<typeof CatalogHostsSDK>,
	import(sdkPath("@oh-my-pi/pi-utils/stream")) as Promise<typeof StreamsSDK>,
	import(sdkPath("@oh-my-pi/pi-utils/abortable")) as Promise<typeof AbortableSDK>,
]);

const REPLAY_APIS: Record<string, true> = {
	"openai-codex-responses": true, "anthropic-messages": true, "bedrock-converse-stream": true,
	"openai-responses": true, "azure-openai-responses": true, "openai-completions": true,
	"google-generative-ai": true, "google-vertex": true, "google-gemini-cli": true,
	"ollama-chat": true,
};
const COMPLETIONS_SUCCESS_FINISH_REASONS: Record<string, true> = {
	stop: true, end: true, length: true, max_tokens: true, function_call: true, tool_calls: true,
};
const ANTHROPIC_MESSAGE_EVENTS: Record<string, true> = {
	message_start: true, message_delta: true, message_stop: true,
	content_block_start: true, content_block_delta: true, content_block_stop: true,
};
const BEDROCK_SUCCESS_STOP_REASONS: Record<string, true> = {
	end_turn: true, stop_sequence: true, max_tokens: true, model_context_window_exceeded: true, tool_use: true,
};

// Settings > Appearance > Theme > Symbol Preset controls Unicode/Nerd Font/ASCII.
// Requires the Custom layout's "status" segment; stock presets do not render it.
// /cache [on|off] shows/hides it; off also suspends warming, on preserves warm setting.
// /cache warm [on|off|now]: paid hidden refreshes retaining the captured cache prefix.
// Codex appends a tiny hidden reply request; other APIs use bounded native caps
// (Anthropic 1: max_tokens 0 is rejected on streaming requests).
// OpenAI tool_choice=none retains cached definitions; unsafe Google tools/modalities
// and budget-based thinking report unavailable, rather than rewriting the prefix.
// ~ is an estimate, not a server TTL or eviction guarantee. Warm cost is separate.
// Only reported cache reuse refreshes the estimate; misses retain the normal cadence.
// A miss shows "warm miss" and unknown expiry; the next scheduled hit restores the estimate.
// SDK imports follow the running OMP installation; no extension-local junction repair is needed.
// Stateful Codex deltas expand only from the last verified foreground wire input
// and native replayable output, committed by the awaited assistant_message hook.
// Delayed message_end notifications never authorize replay of another request.
// Restart/resume starts with a full native request; no foreground chaining setting is changed.
// Hidden refreshes use an isolated connection and never extend the foreground response chain.
// Restores/model/branch changes wait for a real request; unknown TTL uses an
// inferred 4m upkeep interval, never a claimed 4m lifetime.
// Short Ollama keep_alive bounds upkeep without changing policy or claiming a KV TTL;
// zero residency or intervals below the one-second managed scheduler are unavailable.
// Explicit Gemini/Vertex resources renew their actual fixed expiry; storage is billed.
// Load after payload-transforming extensions: a later whole-body replacement is
// not observable through the native hook. Snapshots stay in memory. Hidden Codex
// diagnostic frames are cleared after wire serialization; native request-body
// debugging suspends hidden warming rather than writing private prompts.

const OLLAMA_DURATION_NS: Record<string, number> = {
	ns: 1, us: 1_000, "µs": 1_000, "μs": 1_000, ms: 1_000_000,
	s: 1_000_000_000, m: 60_000_000_000, h: 3_600_000_000_000,
};

export default function cacheControl(pi: ExtensionAPI): void {
	let enabled = true;
	let latest: AssistantMessage | undefined;
	let timer: Timer | undefined;
	let timerContext: ExtensionContext | undefined;
	let warmEnabled = true;
	let foreground = false;
	let shutdown = false;
	let identity = "";
	let revision = 0;
	type CodexChain = { input: unknown[]; output: unknown[]; responseId: string };
	let codexChain: CodexChain | undefined;
	let snapshot: {
		body: Record<string, unknown>; model: Pick<Model, "id" | "provider" | "api" | "requestModelId" | "promptCache" | "pricingStatus">;
		sessionId: string; startedAt: number; ready: boolean; finalized: boolean; parent?: CodexChain;
		delayMs: number; outputCap: number; ttlSeconds?: number; cacheName?: string; expiresAt?: number; residencyMs?: number;
	} | undefined;
	let foregroundAt: number | undefined;
	let warmedAt: number | undefined;
	let warmMiss = false;
	let nextAt: number | undefined;
	let waiting = "Waiting for the next successful real request with a cacheable prefix.";
	let calls = 0;
	let cost = 0;
	let unpriced = 0;
	let storageCalls = 0;
	let active: { controller: AbortController; cancelled: boolean } | undefined;

	function currentIdentity(ctx: ExtensionContext): string {
		const model = ctx.models.current();
		return JSON.stringify([ctx.sessionManager.getSessionId(), model?.provider, model?.id, model?.api]);
	}

	function cancelWarm(): void {
		revision++;
		if (active) {
			active.cancelled = true;
			active.controller.abort();
		}
	}

	function syncIdentity(ctx: ExtensionContext): void {
		const key = currentIdentity(ctx);
		if (key === identity) return;
		cancelWarm();
		identity = key;
		snapshot = undefined;
		codexChain = undefined;
		foregroundAt = warmedAt = nextAt = undefined;
		warmMiss = false;
		waiting = "Waiting for the next successful real request with a cacheable prefix.";
	}

	function stopWarming(ctx: ExtensionContext, reason: string): void {
		warmEnabled = false;
		nextAt = undefined;
		waiting = reason;
		ctx.ui.notify(`Cache warming stopped: ${reason} /cache warm on reenables it.`, "warning");
	}

	function warmStatus(): string {
		let state = active && !active.cancelled ? "running" : !enabled || !warmEnabled || shutdown ? "off"
			: waiting.startsWith("Unavailable:") ? "unavailable" : "pending";
		if (state === "pending" && nextAt !== undefined && snapshot?.ready) {
			state = `${warmMiss ? "miss; " : ""}next in ${duration(Math.max(0, Math.ceil((nextAt - Date.now()) / 1000)))}`;
		}
		const note = warmMiss || state === "pending" || state === "off" || state === "unavailable" ? waiting
			: snapshot?.ttlSeconds === undefined
				? snapshot?.residencyMs !== undefined
					? `Paid ${duration(Math.ceil(snapshot.delayMs / 1000))} maintenance respects native residency; KV TTL remains unknown.`
					: "Paid 4-minute maintenance interval is inferred; TTL remains unknown."
				: "Paid idle-only prefix refreshes; /cache warm off stops them.";
		const storage = snapshot?.cacheName || storageCalls ? " Explicit-cache storage extension is billed; its price is unavailable." : "";
		return `Cache warm ${state}; ${calls} calls; estimated inference warm cost $${cost.toFixed(6)}${unpriced ? ` (${unpriced} unpriced)` : ""}, separate from native footer. ${note}${storage}`;
	}

	async function warm(ctx: ExtensionContext, force = false): Promise<void> {
		syncIdentity(ctx);
		const captured = snapshot;
		if (!enabled || !warmEnabled || shutdown || ctx.mode !== "tui" || !ctx.hasUI || active
			|| !captured?.ready || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		const key = identity;
		const version = revision;
		const job = { controller: new AbortController(), cancelled: false };
		active = job;
		let sentAt: number | undefined;
		let failure = "No verified cache refresh response was received.";
		const states = new Map<string, ProviderSessionState>();
		const timeout = ctx.setTimeout(() => {
			failure = "The 45-second refresh timeout elapsed.";
			job.controller.abort();
		}, 45_000);
		let abortListener: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			abortListener = () => reject(new Error("Warm request aborted"));
			job.controller.signal.addEventListener("abort", abortListener, { once: true });
		});
		const isCurrent = () => active === job && !job.cancelled && !job.controller.signal.aborted
			&& version === revision && identity === key && currentIdentity(ctx) === key
			&& snapshot === captured && enabled && warmEnabled && !shutdown;
		try {
			monitor(ctx);
			const result = await Promise.race([aborted, (async () => {
				if (Bun.env.PI_REQ_DEBUG === "1") {
					failure = "Native request-body debugging is enabled; hidden warming would persist private prompts.";
					throw new Error("Warm request diagnostics refused");
				}
				// Hook contexts can carry resolved transport headers. Reacquire the live
				// model so a delayed refresh never replays stale foreground credentials.
				let model = ctx.models.current();
				if (!model || model.provider !== captured.model.provider || model.id !== captured.model.id || model.api !== captured.model.api) {
					job.cancelled = true;
					throw new Error("Warm model no longer current");
				}
				const apiKey = await ctx.modelRegistry.getApiKey(model, captured.sessionId, { signal: job.controller.signal });
				if (!isCurrent() || !ctx.isIdle() || ctx.hasPendingMessages()) {
					job.cancelled = true;
					throw new Error("Warm request no longer current");
				}
				if (!apiKey && captured.model.api !== "google-vertex" && captured.model.api !== "bedrock-converse-stream"
					&& captured.model.api !== "ollama-chat") {
					failure = "Native model authentication is unavailable.";
					throw new Error("Missing model auth");
				}
				let headers = model.resolveHeaders ? await model.resolveHeaders(job.controller.signal) : model.headers;
				if (!isCurrent() || !ctx.isIdle() || ctx.hasPendingMessages()) {
					job.cancelled = true;
					throw new Error("Warm headers no longer current");
				}
				if (model.resolveHeaders) model = { ...model, headers, resolveHeaders: undefined };
				if (captured.cacheName) {
					// Resource requests use the same freshly resolved native transport headers.
					let url: string;
					if (captured.model.api === "google-vertex") {
						const location = captured.cacheName.split("/")[3];
						const base = model.baseUrl?.trim().replace(/\/$/, "") || `https://${catalogHosts.resolveVertexEndpointHost(location)}`;
						const versioned = /\/v1(?:beta1)?$/.test(base) ? base : `${base}/v1`;
						url = `${versioned}/${captured.cacheName}`;
						const nativeKey = apiKey && !apiKey.startsWith("<") && apiKey !== "N/A" ? apiKey : undefined;
						if (nativeKey) headers = { ...headers, "x-goog-api-key": nativeKey };
						else headers = { ...headers, Authorization: `Bearer ${await googleAuth.getVertexAccessToken({ signal: job.controller.signal })}` };
					} else {
						const base = model.baseUrl?.trim() || "https://generativelanguage.googleapis.com/v1beta";
						url = `${base.replace(/\/$/, "")}/${captured.cacheName}`;
						headers = { ...headers, "x-goog-api-key": apiKey! };
					}
					if (!isCurrent() || !ctx.isIdle() || ctx.hasPendingMessages()) {
						job.cancelled = true;
						throw new Error("Cache metadata request no longer current");
					}
					failure = "Explicit-cache metadata could not be verified.";
					const response = await fetch(url, { headers, signal: job.controller.signal });
					if (!response.ok) throw new Error("Cache metadata failed");
					const lease = await response.json() as { name?: unknown; model?: unknown; expireTime?: unknown; updateTime?: unknown; createTime?: unknown };
					if (!isCurrent() || !ctx.isIdle() || ctx.hasPendingMessages()) {
						job.cancelled = true;
						throw new Error("Cache extension no longer current");
					}
					const expiresAt = typeof lease.expireTime === "string" ? Date.parse(lease.expireTime) : Number.NaN;
					const updated = typeof lease.updateTime === "string" ? Date.parse(lease.updateTime)
						: typeof lease.createTime === "string" ? Date.parse(lease.createTime) : Number.NaN;
					const retentionMs = expiresAt - updated;
					if (lease.name !== captured.cacheName || typeof lease.model !== "string"
						|| lease.model.split("/").at(-1) !== (captured.model.requestModelId ?? captured.model.id)
						|| !Number.isFinite(retentionMs) || retentionMs <= 10_000 || expiresAt <= Date.now()) {
						throw new Error("Invalid cache lease");
					}
					const deadline = expiresAt - Math.max(10_000, Math.floor(retentionMs * 0.1));
					if (!force && Date.now() < deadline) return { cacheExpiry: expiresAt, retentionMs };
					failure = "Explicit-cache storage renewal failed or did not prove a later expiry.";
					// Metadata GETs do not renew a fixed lease; only this PATCH is charged storage upkeep.
					sentAt = Date.now();
					calls++;
					unpriced++;
					storageCalls++;
					const renewal = await fetch(`${url}?updateMask=ttl`, {
						method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
						body: JSON.stringify({ ttl: `${retentionMs / 1000}s` }), signal: job.controller.signal,
					});
					if (!renewal.ok) throw new Error("Cache renewal failed");
					const changed = await renewal.json() as { name?: unknown; expireTime?: unknown };
					const expiry = typeof changed.expireTime === "string" ? Date.parse(changed.expireTime) : Number.NaN;
					if (changed.name !== captured.cacheName || !Number.isFinite(expiry) || expiry <= Date.now() || expiry <= expiresAt) {
						throw new Error("Cache expiry not extended");
					}
					return { cacheExpiry: expiry, retentionMs };
				}
				const codex = captured.model.api === "openai-codex-responses";
				const google = captured.model.api === "google-generative-ai" || captured.model.api === "google-vertex";
				const openai = captured.model.api === "openai-completions" || captured.model.api === "openai-responses"
					|| captured.model.api === "azure-openai-responses";
				const bedrock = captured.model.api === "bedrock-converse-stream";
				let inferenceDispatched = false;
				let warmFrame: Record<string, unknown> | undefined;
				const events = ai.stream(codex ? { ...model, preferWebsockets: true } : model, { messages: [] }, {
					apiKey, sessionId: captured.sessionId, providerSessionState: states,
					// Keep SDK envelope construction valid; the hook applies the actual wire cap.
					maxTokens: captured.outputCap || 1, preferWebsockets: codex, statefulResponses: false, acceptEmptyResponse: true,
					codexSseMaxAttempts: 1, streamFirstEventTimeoutMs: 45_000, streamIdleTimeoutMs: 45_000,
					signal: job.controller.signal,
					fetch: async (input, init) => {
						const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
						// Bedrock credentials and Antigravity discovery can use this fetch after onPayload.
						const inference = sentAt !== undefined && method === "POST"
							&& (captured.model.api !== "bedrock-converse-stream"
								|| new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/converse-stream"))
							&& (captured.model.api !== "google-gemini-cli"
								|| new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith(":streamGenerateContent"));
						if (inference) {
							if (inferenceDispatched) {
								failure = "The provider attempted a retry; automatic warm retries are disabled.";
								job.controller.abort();
								throw new Error("Warm retry refused");
							}
							if (!isCurrent() || !ctx.isIdle() || ctx.hasPendingMessages()) {
								job.cancelled = true;
								job.controller.abort();
								throw new Error("Warm request no longer current");
							}
							inferenceDispatched = true;
						}
						const response = await fetch(input, init);
						if (inference && (response.status === 400 || response.status === 413)) {
							// Hide paid-refresh prompts from native rejected-request disk diagnostics.
							// Abort retries before the SDK can turn this response into a status-bearing error.
							failure = "The provider rejected the refresh; prompt diagnostics were suppressed.";
							job.controller.abort();
							throw new Error("Warm transport rejected");
						}
						if (!inference || captured.model.api === "ollama-chat" || !response.ok || !response.body) return response;
						// Reader cleanup is not a failed warm job. Its own signal also settles a
						// pending native iterator read before return() releases the HTTP reader.
						const transport = new AbortController();
						const signal = AbortSignal.any([job.controller.signal, transport.signal,
							init?.signal ?? (input instanceof Request ? input.signal : job.controller.signal)]);
						const encoder = new TextEncoder();
						const decoder = bedrock ? new TextDecoder() : undefined;
						const codec = decoder ? new EventStreamCodec(bytes => decoder.decode(bytes), text => encoder.encode(text)) : undefined;
						const chunks = bedrock ? abortables.abortableSource(response.body, signal) : undefined;
						const frames = chunks ? (async function* () {
							try {
								yield* getChunkedStream(chunks);
							} finally {
								// Smithy's framer does not return its upstream iterator.
								await chunks.return(undefined);
							}
						})() : streams.readSseEvents(response.body, signal, { captureRaw: true });
						const guarded = new ReadableStream<Uint8Array>({
							async pull(controller) {
								try {
									const frame = await frames.next();
									if (transport.signal.aborted) return;
									if (frame.done) { controller.close(); return; }
									if (codec && decoder) {
										const raw = frame.value as Uint8Array;
										const message = codec.decode(raw);
										const type = message.headers[":message-type"]?.value;
										if (type === "exception" || type === "error") throw new Error("Warm stream rejected");
										if (type === "event" && message.headers[":event-type"]?.value === "messageStop") {
											const payload = JSON.parse(decoder.decode(message.body)) as { stopReason?: unknown } | null;
											if (BEDROCK_SUCCESS_STOP_REASONS[String(payload?.stopReason)] !== true) {
												throw new Error("Warm stream rejected");
											}
										}
										controller.enqueue(raw);
										return;
									}
									const event = frame.value as StreamsSDK.ServerSentEvent;
									let data: unknown;
									let malformed = false;
									try { data = JSON.parse(event.data); } catch {
										malformed = (captured.model.api !== "anthropic-messages"
											|| ANTHROPIC_MESSAGE_EVENTS[event.event ?? ""] === true)
											&& event.data !== "" && event.data !== "[DONE]";
									}
									const value = data && typeof data === "object" ? data as Record<string, unknown> : undefined;
									const result = value?.response as Record<string, unknown> | undefined;
									const details = result?.status_details as Record<string, unknown> | undefined;
									const googlePayload = captured.model.api === "google-gemini-cli" ? result : value;
									const feedback = googlePayload?.promptFeedback as Record<string, unknown> | undefined;
									const candidates = googlePayload?.candidates as { [index: number]: Record<string, unknown>; length?: unknown } | undefined;
									const candidate = candidates?.[0];
									const choice = Array.isArray(value?.choices) ? value.choices[0] as Record<string, unknown> | undefined : undefined;
									const delta = value?.delta as Record<string, unknown> | undefined;
									const status = errors.status(value);
									if (malformed || event.event === "error" || event.event === "response.failed"
										|| value?.type === "error" || value?.type === "response.failed"
										|| (value?.error !== undefined && value.error !== null) || result?.error || details?.error
										|| result?.status === "failed" || result?.status === "cancelled"
										|| value?.code !== undefined || (status !== undefined && status >= 400)
										|| (openai && (errors.createInBandProviderError(data)
											|| (typeof data === "string" && errors.createInBandProviderErrorFromText(data))))
										|| (captured.model.api === "openai-completions"
											&& (typeof value?.message === "string" || (choice?.finish_reason
												&& COMPLETIONS_SUCCESS_FINISH_REASONS[String(choice.finish_reason).toLowerCase()] !== true)))
										|| ((google || captured.model.api === "google-gemini-cli")
											&& ((feedback?.blockReason && !candidates?.length)
												|| (candidate?.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS")))
										|| (captured.model.api === "anthropic-messages" && value?.type === "message_delta"
											&& (delta?.stop_reason === "refusal" || delta?.stop_reason === "sensitive"))) {
										// Even statusless provider messages can trigger native rejected-request
										// dumps. Reject failure frames before any private detail reaches the SDK.
										failure = "The provider rejected the refresh; prompt diagnostics were suppressed.";
										controller.error(new Error("Warm stream rejected"));
										job.controller.abort();
										await frames.return(undefined);
										return;
									}
									controller.enqueue(encoder.encode(`${event.raw.join("\n")}\n\n`));
								} catch {
									if (transport.signal.aborted) return;
									// Framing/transport exceptions can echo server data too.
									failure = "The refresh stream failed; prompt diagnostics were suppressed.";
									controller.error(new Error("Warm stream rejected"));
									job.controller.abort();
									await frames.return(undefined);
								}
							},
							async cancel() {
								transport.abort();
								await frames.return(undefined);
							},
						}, { highWaterMark: 0 });
						return new Response(guarded, { status: response.status, statusText: response.statusText, headers: response.headers });
					},
					onSseEvent: codex ? event => {
						if (event.event === "response.create" && event.raw[0]?.startsWith(": ws → ")) {
							// Native JSON.stringify has already produced immutable send bytes.
							// This isolated frame also aliases rawRequestDump.body; clear its
							// private fields BEFORE any later status-bearing error is finalized.
							if (warmFrame) {
								for (const key of Object.keys(warmFrame)) delete warmFrame[key];
								warmFrame.type = "response.create";
								warmFrame = undefined;
							}
						} else if (event.event === "error" || event.event === "response.failed") {
							// The raw observer runs before native error parsing/queueing.
							// Abort there, not after AIError.finalize has persisted diagnostics.
							failure = "The provider rejected the refresh; prompt diagnostics were suppressed.";
							job.controller.abort();
						}
					} : undefined,
					onPayload: payload => {
						// Codex failures can fall back to HTTP. Refuse BEFORE any HTTP send.
						if (codex && (!payload || typeof payload !== "object" || !("type" in payload) || payload.type !== "response.create")) {
							failure = "WebSocket transport is unavailable; HTTP Codex warming is not supported.";
							throw new Error("WebSocket required");
						}
						if (sentAt !== undefined) {
							failure = "The provider attempted a retry; automatic warm retries are disabled.";
							throw new Error("Warm retry refused");
						}
						if (!isCurrent() || !ctx.isIdle() || ctx.hasPendingMessages()) {
							job.cancelled = true;
							throw new Error("Warm request no longer current");
						}
						const body = structuredClone(captured.body);
						if (body.previous_response_id !== undefined) {
							failure = "An incremental prefix cannot be replayed on an isolated transport.";
							throw new Error("Incremental prefix refused");
						}
						if (codex) {
							// Preserve all cache-affecting fields; use fresh transport identity.
							delete body.stream;
							const metadata = body.client_metadata;
							const nativeMetadata = payload && typeof payload === "object" && "client_metadata" in payload ? payload.client_metadata : undefined;
							body.client_metadata = {
								...(metadata && typeof metadata === "object" ? metadata : {}),
								...(nativeMetadata && typeof nativeMetadata === "object" ? nativeMetadata : {}),
							};
							delete (body.client_metadata as Record<string, unknown>)["x-codex-turn-state"];
							body.type = "response.create";
							delete body.generate;
							const input = body.input as unknown[];
							if (/^gpt-6(?:[.-]|$)/i.test(captured.model.requestModelId ?? captured.model.id)) {
								input.push({ type: "configuration_update", reasoning: { effort: "low" } });
							}
							input.push({ role: "user", content: [{ type: "input_text", text: "Reply with only: ok" }] });
							if (Array.isArray(body.tools) && body.tools.length) body.tool_choice = "none";
						} else if (captured.model.api === "anthropic-messages") {
							body.max_tokens = captured.outputCap;
						} else if (captured.model.api === "bedrock-converse-stream") {
							body.inferenceConfig = { ...(body.inferenceConfig as Record<string, unknown>), maxTokens: captured.outputCap };
						} else if (captured.model.api === "openai-responses" || captured.model.api === "azure-openai-responses") {
							body.max_output_tokens = captured.outputCap;
							// OpenAI documents this as cache-safe: keep definitions, disable execution.
							if (Array.isArray(body.tools) && body.tools.length) body.tool_choice = "none";
						} else if (captured.model.api === "openai-completions") {
							body[body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens"] = captured.outputCap;
							if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) body.max_tokens = captured.outputCap;
							if (Array.isArray(body.tools) && body.tools.length) body.tool_choice = "none";
						} else if (captured.model.api === "ollama-chat") {
							body.options = { ...(body.options as Record<string, unknown>), num_predict: captured.outputCap };
						} else if (captured.model.api === "google-gemini-cli") {
							const request = body.request as Record<string, unknown>;
							request.generationConfig = { ...(request.generationConfig as Record<string, unknown>), maxOutputTokens: captured.outputCap };
							if (payload && typeof payload === "object" && "requestId" in payload) body.requestId = payload.requestId;
						} else {
							const nativeConfig = payload && typeof payload === "object" && "config" in payload && payload.config && typeof payload.config === "object"
								? payload.config as Record<string, unknown> : undefined;
							body.config = { ...(body.config as Record<string, unknown>), maxOutputTokens: captured.outputCap,
								abortSignal: job.controller.signal, ...(nativeConfig?.httpOptions ? { httpOptions: nativeConfig.httpOptions } : {}) };
						}
						sentAt = Date.now();
						calls++;
						unpriced++;
						if (codex) warmFrame = body;
						return body;
					},
				});
				let completed: AssistantMessage | undefined;
				for await (const event of events) {
					if (event.type === "start") continue;
					if (event.type === "done") {
						completed = event.message;
					} else if (event.type === "error") {
						throw new Error("Provider warm request failed");
					} else if (event.type.startsWith("toolcall") || event.type === "image_end"
						|| (codex ? event.partial.content.reduce((n, block) => n + (block.type === "text" ? block.text.length : 0), 0) > 64
							: event.partial.usage.output > captured.outputCap)) {
						failure = "The provider emitted forbidden output; warming is disabled.";
						job.controller.abort();
						throw new Error("Warm output refused");
					}
				}
				return completed;
			})()]);
			if (result && "cacheExpiry" in result) {
				if (!isCurrent()) return;
				captured.expiresAt = result.cacheExpiry;
				captured.ttlSeconds = result.retentionMs / 1000;
				nextAt = result.cacheExpiry - Math.max(10_000, Math.floor(result.retentionMs * 0.1));
				waiting = "Explicit-cache storage renewal is enabled.";
				return;
			}
			const usage = result?.usage;
			const reportedCost = usage?.cost.total;
			if (sentAt !== undefined && reportedCost !== undefined && Number.isFinite(reportedCost) && reportedCost >= 0
				&& (reportedCost > 0 || captured.model.pricingStatus === "free" || captured.model.pricingStatus === "included")) {
				cost += reportedCost;
				unpriced--;
			}
			if (!isCurrent()) return;
			const tokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
			const usable = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(n => Number.isFinite(n) && n >= 0);
			const codex = captured.model.api === "openai-codex-responses";
			const sol = codex && captured.model.provider === "openai-codex" && captured.model.id === "gpt-6.1-sol";
			if (sentAt === undefined || !result || (result.stopReason !== "stop" && result.stopReason !== "length")
				|| !usable || (!codex && usage.output > captured.outputCap) || tokens <= 0 || (sol && tokens < 1024)
				|| result.content.some(block => block.type === "toolCall" || block.type === "image")
				|| (codex && result.content.reduce((n, block) => n + (block.type === "text" ? block.text.length : 0), 0) > 64)
				|| result.provider !== captured.model.provider || result.model !== captured.model.id) {
				failure = "The response did not prove bounded output with usable cache-token usage.";
				throw new Error("Unverified warm response");
			}
			warmMiss = usage.cacheRead <= 0;
			nextAt = Math.max(foregroundAt ?? 0, sentAt) + captured.delayMs;
			if (warmMiss) {
				waiting = "Warm miss: the response reported no cache reuse; expiry was not refreshed and TTL remains unknown.";
				return;
			}
			warmedAt = sentAt;
			waiting = "Paid refreshes are enabled.";
		} catch {
			if (!job.cancelled && version === revision && identity === key && currentIdentity(ctx) === key && !shutdown) {
				stopWarming(ctx, failure);
			}
		} finally {
			ctx.clearTimer(timeout);
			if (abortListener) job.controller.signal.removeEventListener("abort", abortListener);
			for (const state of states.values()) {
				try { state.close(); } catch {
					if (!job.cancelled && version === revision && currentIdentity(ctx) === key && !shutdown) {
						stopWarming(ctx, "Provider transport cleanup failed.");
					}
				}
			}
			states.clear();
			if (active === job) active = undefined;
			if (!shutdown && currentIdentity(ctx) === identity) monitor(ctx);
		}
	}

	function stopTimer(): void {
		if (timer !== undefined) timerContext?.clearTimer(timer);
		timer = undefined;
		timerContext = undefined;
	}

	function seed(ctx: ExtensionContext): void {
		latest = undefined;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				latest = entry.message;
				break;
			}
		}
	}

	function duration(seconds: number): string {
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	}

	function monitor(ctx: ExtensionContext): void {
		syncIdentity(ctx);
		if (!ctx.hasUI || !enabled) return;
		const theme = ctx.ui.theme;
		const label = theme.symbol("icon.cache");
		const model = ctx.models.current();
		const indicator = model ? `${theme.symbol("sep.dot")}${active && !active.cancelled ? "warming"
			: !warmEnabled ? "warm off" : waiting.startsWith("Unavailable:") ? "warm unavailable"
			: warmMiss ? "warm miss" : snapshot?.cacheName && snapshot.expiresAt !== undefined ? "lease"
			: snapshot?.ready && warmedAt !== undefined ? "warm" : "warm pending"}` : "";
		if (!latest || (model && (latest.provider !== model.provider || latest.model !== model.id))) {
			const empty = theme.getSymbolPreset() === "ascii" ? "-" : "—";
			ctx.ui.setStatus("prompt-cache", (latest ? `${label} pending` : `${label} ${empty}`) + indicator);
			return;
		}
		const usage = latest.usage;
		const total = usage.input + usage.cacheRead + usage.cacheWrite;
		if (total <= 0) {
			ctx.ui.setStatus("prompt-cache", `${label} ${theme.getSymbolPreset() === "ascii" ? "-" : "—"}${indicator}`);
			return;
		}
		const reuse = `${Math.round((usage.cacheRead / total) * 100)}%`;
		const anchor = Number.isFinite(latest.timestamp)
			? Math.max(latest.timestamp, foregroundAt ?? 0, warmedAt ?? 0) : latest.timestamp;
		const age = Number.isFinite(anchor) ? Math.max(0, Math.floor((Date.now() - anchor) / 1000)) : undefined;

		// Request-start anchoring is conservative: cache prefix processing precedes output.
		// Codex/Sol's 30m window below is an explicit public-API assumption, not a backend TTL.
		const long = (usage.cttl?.ephemeral1h ?? 0) > 0;
		const short = (usage.cttl?.ephemeral5m ?? 0) > 0;
		const ttl = long !== short ? model?.promptCache?.[long ? "long" : "short"]
			: warmedAt !== undefined ? snapshot?.ttlSeconds : undefined;
		const usable = latest.stopReason !== "error" && latest.stopReason !== "aborted";
		const assumeSol = usable && total >= 1024 && !long && !short && model?.provider === "openai-codex" && model.id === "gpt-6.1-sol";
		let expiry = "ttl ?";
		if (warmMiss) {
			expiry = "ttl ?";
		} else if (usable && snapshot?.cacheName && snapshot.expiresAt !== undefined) {
			const remaining = Math.ceil((snapshot.expiresAt - Date.now()) / 1000);
			expiry = remaining > 0 ? `~${duration(remaining)}` : "~expired";
		} else if (usable && age !== undefined && ttl !== undefined && Number.isFinite(ttl) && ttl > 0) {
			const remaining = Math.ceil(ttl - age);
			expiry = remaining > 0 ? `~${duration(remaining)}` : "~expired";
		} else if (assumeSol && age !== undefined) {
			const remaining = 30 * 60 - age;
			expiry = remaining > 0 ? `~${duration(remaining)}` : "~expired";
		}
		ctx.ui.setStatus("prompt-cache", `${label} ${reuse}${theme.symbol("sep.dot")}${expiry}${indicator}`);
	}

	function startTimer(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !enabled || timer !== undefined) return;
		timerContext = ctx;
		// Reuse the native managed UI timer: no second polling loop or startup turn.
		timer = ctx.setInterval(() => {
			monitor(ctx);
			if (nextAt !== undefined && Date.now() >= nextAt) void warm(ctx);
		}, 1000);
	}

	function refresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("cache-control", undefined);
		ctx.ui.setWidget("cache-monitor", undefined);
		if (enabled) monitor(ctx);
		else ctx.ui.setStatus("prompt-cache", undefined);
	}

	function reset(ctx: ExtensionContext): void {
		stopTimer();
		cancelWarm();
		foreground = false;
		identity = currentIdentity(ctx);
		snapshot = undefined;
		codexChain = undefined;
		foregroundAt = warmedAt = nextAt = undefined;
		warmMiss = false;
		waiting = "Waiting for the next successful real request with a cacheable prefix.";
		latest = undefined;
		if (!ctx.hasUI) return;
		ctx.ui.setTitle("");
		seed(ctx);
		refresh(ctx);
		startTimer(ctx);
	}

	pi.registerCommand("cache", {
		description: "Custom cache status [on|off] (on preserves warm setting); warm [on|off|now] paid hidden prefix refreshes (~ estimated)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const action = args.trim().replace(/\s+/g, " ");
			if (!["", "on", "off", "warm", "warm on", "warm off", "warm now"].includes(action)) {
				ctx.ui.notify("Usage: /cache [on|off] or /cache warm [on|off|now] (paid; off hides and suspends, on preserves warm setting)", "warning");
				return;
			}
			syncIdentity(ctx);
			if (action.startsWith("warm")) {
				if (ctx.mode !== "tui" || shutdown) {
					ctx.ui.notify("Cache warming requires an open native TUI session.", "warning");
					return;
				}
				if (action === "warm off") {
					warmEnabled = false;
					cancelWarm();
					waiting = "Disabled manually; /cache warm on reenables paid refreshes.";
				} else if (action === "warm on") {
					warmEnabled = true;
					if (snapshot?.ready) {
						waiting = "Paid refreshes are enabled.";
						nextAt = snapshot.cacheName ? snapshot.expiresAt === undefined ? Date.now()
							: snapshot.expiresAt - Math.max(10_000, Math.floor((snapshot.ttlSeconds ?? 0) * 100))
							: Math.max(foregroundAt ?? snapshot.startedAt, warmedAt ?? 0) + snapshot.delayMs;
					}
				} else if (action === "warm now") {
					if (!ctx.isIdle() || ctx.hasPendingMessages()) {
						ctx.ui.notify("Cache warm pending: wait until the agent is idle and queued messages finish.", "info");
						return;
					}
					await warm(ctx, true);
				}
				refresh(ctx);
				ctx.ui.notify(warmStatus(), "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				cancelWarm();
				stopTimer();
			} else {
				enabled = true;
				seed(ctx);
				startTimer(ctx);
			}
			refresh(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		shutdown = false;
		reset(ctx);
	});
	pi.on("session_switch", (_event, ctx) => reset(ctx));
	pi.on("session_branch", (_event, ctx) => reset(ctx));
	pi.on("session_tree", (_event, ctx) => reset(ctx));
	pi.on("session_compact", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		shutdown = true;
		foreground = false;
		cancelWarm();
		snapshot = undefined;
		codexChain = undefined;
		foregroundAt = warmedAt = nextAt = undefined;
		enabled = false;
		latest = undefined;
		stopTimer();
		refresh(ctx);
	});
	// Installed OMP has no model-select extension hook; monitor reads current model each tick.
	pi.on("before_agent_start", (_event, ctx) => {
		cancelWarm();
		foreground = true;
		snapshot = undefined;
		nextAt = undefined;
		if (warmEnabled) waiting = "Waiting for the next successful real request with a cacheable prefix.";
		refresh(ctx);
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (!foreground || shutdown || ctx.mode !== "tui" || !ctx.hasUI) return;
		cancelWarm();
		syncIdentity(ctx);
		snapshot = undefined;
		nextAt = undefined;
		warmedAt = undefined;
		warmMiss = false;
		const model = ctx.model ?? ctx.models.current();
		const body = event.payload;
		if (!model || !body || typeof body !== "object" || Array.isArray(body)) {
			codexChain = undefined;
			return;
		}
		const current = ctx.models.current();
		if (!current || current.provider !== model.provider || current.id !== model.id || current.api !== model.api) {
			codexChain = undefined;
			return;
		}
		const payload = body as Record<string, unknown>;
		if (REPLAY_APIS[model.api] !== true) {
			codexChain = undefined;
			waiting = "Unavailable: this API has no verified exact-prefix, bounded-output replay adapter.";
			return;
		}
		const request = model.api === "google-gemini-cli" && payload.request && typeof payload.request === "object"
			? payload.request as Record<string, unknown> : payload;
		const input = request.input ?? request.messages ?? request.contents;
		const google = model.api === "google-generative-ai" || model.api === "google-vertex";
		// A later in-place hook can add an explicit resource to empty Google contents.
		if ((!Array.isArray(input) || (input.length === 0 && !google))
			// Antigravity sends thinking-level variants (gemini-3.8-flash-high) of the same model.
			|| (payload.model !== undefined && payload.model !== (model.requestModelId ?? model.id)
				&& !(model.api === "google-gemini-cli" && typeof payload.model === "string" && payload.model.startsWith(`${model.id}-`)))
			|| (payload.type !== undefined && payload.type !== "response.create")) {
			codexChain = undefined;
			waiting = "Unavailable: this payload does not expose a full, matching replayable prefix.";
			return;
		}
		let parent: CodexChain | undefined;
		if (payload.previous_response_id !== undefined) {
			if (model.api !== "openai-codex-responses" || !codexChain
				|| typeof payload.previous_response_id !== "string" || payload.previous_response_id !== codexChain.responseId) {
				codexChain = undefined;
				waiting = "Unavailable: incremental input has no verified matching Codex foreground chain; wait for a full real request.";
				return;
			}
			parent = codexChain;
		}
		// Keep the reference so subsequent in-place hook edits are captured. Later
		// hooks replacing the entire body are not observable through this public hook.
		const outputCap = model.api === "openai-codex-responses" || model.api === "openai-responses" || model.api === "azure-openai-responses"
			|| (model.api === "openai-completions" && (model.reasoning || (payload.reasoning_effort !== undefined && payload.reasoning_effort !== "none"))) ? 16 : 1;
		snapshot = { body: payload,
			model: { id: model.id, provider: model.provider, api: model.api, requestModelId: model.requestModelId,
				promptCache: model.promptCache ? { ...model.promptCache } : undefined, pricingStatus: model.pricingStatus },
			sessionId: ctx.sessionManager.getSessionId(), startedAt: Date.now(), ready: false, finalized: false, parent,
			delayMs: 4 * 60_000, outputCap };
	});
	// This awaited native hook settles the originating stream BEFORE the next
	// provider request/tool continuation. Notification delivery is not ownership.
	pi.on("assistant_message", (event, ctx) => {
		if (!ctx.hasUI) return;
		syncIdentity(ctx);
		const captured = snapshot;
		if (captured && !captured.finalized && event.message.provider === captured.model.provider && event.message.model === captured.model.id
			&& (captured.model.api !== "openai-codex-responses" || event.message.api === captured.model.api)) {
			captured.finalized = true;
			const usage = event.message.usage;
			if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted"
				&& [usage.input, usage.cacheRead, usage.cacheWrite].every(n => Number.isFinite(n) && n >= 0)
				&& usage.input + usage.cacheRead + usage.cacheWrite > 0) {
				if (captured.model.api === "google-generative-ai" || captured.model.api === "google-vertex") {
					// Settle resource identity from the same final payload that supplied the real wire prefix.
					const config = captured.body.config;
					const resource = config && typeof config === "object" && "cachedContent" in config ? config.cachedContent : undefined;
					captured.cacheName = undefined;
					if (resource) {
						if (typeof resource !== "string" || !(captured.model.api === "google-generative-ai"
							? /^cachedContents\/[A-Za-z0-9_-]+$/.test(resource)
							: /^projects\/[A-Za-z0-9_-]+\/locations\/[a-z0-9-]+\/cachedContents\/[A-Za-z0-9_-]+$/.test(resource))) {
							waiting = "Unavailable: explicit-cache resource identity is not valid for this provider API.";
							captured.ready = false;
							nextAt = undefined;
							refresh(ctx);
							return;
						}
						captured.cacheName = resource;
					} else if (!Array.isArray(captured.body.contents) || captured.body.contents.length === 0) {
						waiting = "Unavailable: this payload does not expose a full, matching replayable prefix.";
						captured.ready = false;
						nextAt = undefined;
						refresh(ctx);
						return;
					}
				}
				if (captured.model.api === "openai-codex-responses") {
					const parent = captured.parent;
					if (!Array.isArray(captured.body.input) || captured.body.input.length === 0
						|| (captured.body.model !== undefined && captured.body.model !== (captured.model.requestModelId ?? captured.model.id))
						|| (captured.body.type !== undefined && captured.body.type !== "response.create")
						|| (parent ? codexChain !== parent || captured.body.previous_response_id !== parent.responseId
							: captured.body.previous_response_id !== undefined)) {
						codexChain = undefined;
						captured.parent = undefined;
						captured.ready = false;
						nextAt = undefined;
						waiting = "Unavailable: the final Codex request no longer exposes a verified matching prefix; wait for a full real request.";
						refresh(ctx);
						return;
					}
					// Freeze the final wire body, including later in-place hook edits.
					// Never reconstruct from session history: hooks can transform that history.
					captured.body = structuredClone(captured.body);
					if (parent) {
						captured.body.input = [...parent.input, ...parent.output, ...(captured.body.input as unknown[])];
						delete captured.body.previous_response_id;
					}
					captured.parent = undefined;
					codexChain = undefined;
					if (typeof event.message.responseId === "string" && event.message.responseId.length > 0) {
						try {
							const raw = typeof responses.getOpenAIResponsesHistoryItems === "function"
								? responses.getOpenAIResponsesHistoryItems(event.message.providerPayload, captured.model.provider, event.message.provider) : undefined;
							const output = raw && typeof responses.sanitizeOpenAIResponsesAssistantHistoryItemsForReplay === "function"
								? responses.sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(structuredClone(raw)) : undefined;
							// Match native canAppend: dropping even one server-held item breaks proof.
							if (raw && output && output.length === raw.length) {
								codexChain = { input: captured.body.input as unknown[], output, responseId: event.message.responseId };
							}
						} catch {
							// The captured full request still warms; unproven output cannot seed a delta.
						}
					}
				} else if (captured.body.previous_response_id !== undefined) {
					waiting = "Unavailable: incremental input cannot be reconstructed for this API; wait for a full real request.";
					nextAt = undefined;
					refresh(ctx);
					return;
				}
				const sol = captured.model.api === "openai-codex-responses" && captured.model.provider === "openai-codex" && captured.model.id === "gpt-6.1-sol";
				const local = captured.model.api === "ollama-chat" && captured.model.provider === "ollama";
				const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
				// Ollama residency is not a KV lease. Preserve keep_alive; only bound
				// the cadence. Go durations truncate each component to whole nanoseconds.
				let residencyMs: number | undefined;
				if (captured.model.api === "ollama-chat") {
					const value = captured.body.keep_alive;
					if (typeof value === "number" && Number.isFinite(value)) residencyMs = Math.trunc(value * 1e9) / 1e6;
					else if (typeof value === "string") {
						const text = value.trim();
						if (/^[+-]?0$/.test(text)) residencyMs = 0;
						else {
							const duration = text.replace(/^[+-]/, "");
							let nanos = 0, offset = 0;
							for (const part of duration.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|[µμ]s|ms|s|m|h)/g)) {
								if (part.index !== offset) { offset = -1; break; }
								nanos += Math.floor(Number(part[1]) * OLLAMA_DURATION_NS[part[2]]);
								offset += part[0].length;
							}
							if (offset === duration.length && offset > 0 && Number.isFinite(nanos)) residencyMs = (text.startsWith("-") ? -nanos : nanos) / 1e6;
						}
					}
				}
				const long = (usage.cttl?.ephemeral1h ?? 0) > 0;
				const short = (usage.cttl?.ephemeral5m ?? 0) > 0;
				let seconds = long !== short ? captured.model.promptCache?.[long ? "long" : "short"] : undefined;
				let sawShort = false;
				let sawLong = false;
				const pending: unknown[] = [captured.body];
				while (pending.length) {
					const value = pending.pop();
					if (!value || typeof value !== "object") continue;
					if ("cache_control" in value && value.cache_control && typeof value.cache_control === "object") {
						const control = value.cache_control;
						if ("type" in control && control.type === "ephemeral") {
							if ("ttl" in control && control.ttl === "1h") sawLong = true;
							else if (!("ttl" in control) || control.ttl === "5m") sawShort = true;
						}
					}
					if (captured.model.api === "bedrock-converse-stream" && "cachePoint" in value
						&& value.cachePoint && typeof value.cachePoint === "object") {
						if ("ttl" in value.cachePoint && value.cachePoint.ttl === "1h") sawLong = true;
						else sawShort = true;
					}
					for (const child of Object.values(value)) if (child && typeof child === "object") pending.push(child);
				}
				if (seconds === undefined && sawLong !== sawShort) {
					seconds = captured.model.promptCache?.[sawLong ? "long" : "short"];
					if (seconds === undefined && (captured.model.api === "anthropic-messages" || captured.model.api === "bedrock-converse-stream")) {
						seconds = sawLong ? 3600 : 300;
					}
				}
				if (seconds === undefined && !sawLong && !sawShort) {
					const a = captured.model.promptCache?.short;
					const b = captured.model.promptCache?.long;
					if (a !== undefined && b === undefined) seconds = a;
					else if (a === b) seconds = a;
				}
				const known = local || captured.cacheName !== undefined || captured.model.promptCache?.short !== undefined || captured.model.promptCache?.long !== undefined || seconds !== undefined;
				let delayMs = sol ? 25 * 60_000 : seconds === undefined ? 4 * 60_000
					: Math.floor(seconds <= 10 ? seconds * 900 : Math.min(seconds * 900, seconds * 1000 - 10_000));
				if (residencyMs !== undefined && Number.isFinite(residencyMs) && residencyMs > 0) {
					// Reserve a shared 1s heartbeat when the 90% target leaves less margin.
					const target = residencyMs <= 10_000 ? residencyMs * 0.9 : Math.min(residencyMs * 0.9, residencyMs - 10_000);
					delayMs = Math.min(delayMs, Math.floor(Math.min(target, residencyMs - 1000)));
				}
				let unsafe: string | undefined;
				if ((captured.model.api === "openai-responses" || captured.model.api === "azure-openai-responses")
					&& captured.body.conversation) {
					unsafe = "Unavailable: linked server conversations would append hidden turns; wait for a stateless full-context request.";
				}
				const extra = captured.body.additionalModelRequestFields;
				const thinking = captured.body.thinking ?? (extra && typeof extra === "object" && "thinking" in extra ? extra.thinking : undefined);
				if ((captured.model.api === "anthropic-messages" || captured.model.api === "bedrock-converse-stream")
					&& thinking && typeof thinking === "object" && "type" in thinking && thinking.type === "enabled") {
					unsafe = "Unavailable: budget-based thinking cannot preserve this prefix under a bounded output cap.";
				}
				if (!captured.cacheName && (captured.model.api === "google-generative-ai"
					|| captured.model.api === "google-vertex" || captured.model.api === "google-gemini-cli")) {
					const request = captured.body.request && typeof captured.body.request === "object" ? captured.body.request as Record<string, unknown> : undefined;
					const generation = captured.model.api === "google-gemini-cli" ? request?.generationConfig : captured.body.config;
					const settings = generation && typeof generation === "object" ? generation as Record<string, unknown> : undefined;
					const tools = captured.model.api === "google-gemini-cli" ? request?.tools : settings?.tools;
					if (Array.isArray(settings?.responseModalities) && settings.responseModalities.some(value => value !== "TEXT")) {
						unsafe = "Unavailable: non-text generation cannot be bounded safely for hidden cache maintenance.";
					} else if (tools !== undefined && (!Array.isArray(tools) || tools.some(value => !value || typeof value !== "object"
						|| Object.keys(value).some(key => key !== "functionDeclarations")))) {
						unsafe = "Unavailable: server-side tools cannot be disabled cache-safely for this provider.";
					}
				}
				if (unsafe) {
					waiting = unsafe;
					captured.ready = false;
					nextAt = undefined;
				} else if (residencyMs === 0) {
					waiting = "Unavailable: zero native residency unloads the model after every request; its cache cannot stay resident.";
					captured.ready = false;
					nextAt = undefined;
				} else if (!captured.cacheName && (captured.model.api === "google-generative-ai"
					|| captured.model.api === "google-vertex" || captured.model.api === "google-gemini-cli")
					&& event.message.content.some(block => block.type === "image")) {
					waiting = "Unavailable: observed non-text generation cannot be bounded safely for hidden cache maintenance.";
					captured.ready = false;
					nextAt = undefined;
				} else if ((sol && tokens < 1024) || (!sol && !local && tokens < 1024 && usage.cacheRead + usage.cacheWrite <= 0)) {
					waiting = "Waiting for a real request large enough to cache.";
					captured.ready = false;
					nextAt = undefined;
				} else if (!sol && !known && usage.cacheRead + usage.cacheWrite <= 0) {
					waiting = "Unavailable: no observed cache usage or declared cache capability; no paid requests will be sent.";
					captured.ready = false;
					nextAt = undefined;
				} else if ((seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) || !Number.isFinite(delayMs) || delayMs < 1000) {
					waiting = "Unavailable: the lifetime or residency is too short for the managed one-second refresh scheduler.";
					captured.ready = false;
					nextAt = undefined;
				} else {
					let body = captured.body;
					if (captured.model.api === "google-generative-ai" || captured.model.api === "google-vertex") {
						const config = { ...(body.config as Record<string, unknown>) };
						// SDK-only transport fields are not the prompt and may retain old auth/signals.
						delete config.abortSignal;
						delete config.httpOptions;
						body = { ...body, config };
					}
					if (captured.model.api !== "openai-codex-responses") captured.body = structuredClone(body);
					captured.ready = true;
					captured.ttlSeconds = sol ? 30 * 60 : seconds;
					// Native 90%/10s-margin cadence; unknown TTL keeps inferred 4m upkeep.
					captured.delayMs = delayMs;
					captured.residencyMs = residencyMs !== undefined && Number.isFinite(residencyMs) && residencyMs > 0 ? residencyMs : undefined;
					foregroundAt = captured.startedAt;
					warmMiss = false;
					// Fixed explicit-cache expiry is queried while idle; foreground reads
					// must never postpone its deadline or pretend to renew it.
					nextAt = captured.cacheName ? Date.now() : Math.max(foregroundAt, warmedAt ?? 0) + captured.delayMs;
					if (warmEnabled) waiting = "Paid refreshes are enabled.";
				}
			} else {
				codexChain = undefined;
				captured.parent = undefined;
				captured.ready = false;
				nextAt = undefined;
			}
		}
		refresh(ctx);
	});
	pi.on("message_end", (event, ctx) => {
		if (!ctx.hasUI || event.message.role !== "assistant") return;
		latest = event.message;
		syncIdentity(ctx);
		refresh(ctx);
	});
	// Native replay cannot race this extension or bill while /cache is off.
	pi.on("cache_warming_decision", (_event, ctx) => ctx.hasUI && ctx.mode === "tui" ? { action: "stop" } : undefined);
	// message_end notification can precede persistence. Re-read native history at settle.
	pi.on("turn_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		seed(ctx);
		refresh(ctx);
	});
	pi.on("agent_end", (_event, ctx) => {
		foreground = false;
		if (snapshot?.model.api === "openai-codex-responses" && !snapshot.finalized) {
			codexChain = undefined;
			snapshot = undefined;
			nextAt = undefined;
			waiting = "Unavailable: the foreground request ended without a matching successful reply; wait for a full real request.";
		}
		if (!ctx.hasUI) return;
		seed(ctx);
		refresh(ctx);
	});
}
