import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import * as googleAuth from "@oh-my-pi/pi-ai/providers/google-auth";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as nativeUtils from "@oh-my-pi/pi-utils";
import {
	createOpenAIResponsesHistoryPayload, getOpenAIResponsesHistoryItems,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "@oh-my-pi/pi-ai/utils";
import type { AssistantMessage, AssistantMessageEvent, StreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { EventStreamCodec } from "@smithy/core/event-streams";
import { SYMBOL_PRESETS, type SymbolKey, type SymbolPreset } from "@oh-my-pi/pi-tui/theme/symbols";
import cacheControl from "../cache-control";

// bun run test

const NOW = 1_800_000_000_000;
const nativeFetch = globalThis.fetch;
let clock: Mock<typeof Date.now>;
let provider: Mock<typeof ai.stream>;
let cacheHttp: Mock<typeof fetch>;
let networkPreconnect: Mock<typeof fetch.preconnect>;
let vertexAuth: Mock<typeof googleAuth.getVertexAccessToken>;
function rejectPreconnect(): never {
	throw new Error("Unexpected network preconnect");
}

function isolatedFetch(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
	return Object.assign(implementation, { preconnect: rejectPreconnect });
}

beforeEach(() => {
	clock = spyOn(Date, "now").mockReturnValue(NOW);
	provider = spyOn(ai, "stream").mockImplementation(() => { throw new Error("Unexpected paid provider call"); });
	networkPreconnect = spyOn(globalThis.fetch, "preconnect").mockImplementation(rejectPreconnect);
	cacheHttp = spyOn(globalThis, "fetch").mockImplementation(isolatedFetch(async () => { throw new Error("Unexpected cache-management request"); }));
	Object.assign(cacheHttp, { preconnect: networkPreconnect });
	vertexAuth = spyOn(googleAuth, "getVertexAccessToken").mockResolvedValue("native-test-access");
});
afterEach(() => { clock.mockRestore(); provider.mockRestore(); cacheHttp.mockRestore(); networkPreconnect.mockRestore(); vertexAuth.mockRestore(); });

function usage(input = 0, cacheRead = 0, cacheWrite = 0): AssistantMessage["usage"] {
	return {
		input, output: 9_000, cacheRead, cacheWrite,
		totalTokens: input + cacheRead + cacheWrite + 9_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(tokens = usage(), extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: "Recorded reply" }],
		api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol",
		usage: tokens, stopReason: "stop", timestamp: NOW - 10_000, completedAt: NOW - 10_000,
		...extra,
	};
}

type Model = {
	id: string; provider: string; api?: string; preferWebsockets?: boolean;
	baseUrl?: string; headers?: Record<string, string>;
	resolveHeaders?: ai.Model["resolveHeaders"];
	promptCache?: { short?: number; long?: number };
};

function surface() {
	let status: string | undefined;
	let symbolPreset: SymbolPreset = "unicode";
	const notifications: string[] = [];
	const ui = {
		get theme() {
			const preset = symbolPreset;
			return {
				symbol: (key: SymbolKey) => SYMBOL_PRESETS[preset][key],
				getSymbolPreset: () => preset,
			};
		},
		setTitle: () => {},
		setStatus: (_key: string, text: string | undefined) => { status = text; },
		setWidget: () => {},
		notify: (text: string) => { notifications.push(text); },
	};
	return {
		ui, notifications,
		get status() { return status; },
		setSymbolPreset(preset: SymbolPreset) { symbolPreset = preset; },
	};
}

function context(history: AssistantMessage[] = [], model: Model = {
	id: "gpt-6.1-sol", provider: "openai-codex", api: "openai-codex-responses",
}, display = surface()) {
	const timers = new Map<object, () => void>();
	const timeouts = new Map<object, () => void>();
	let sessionId = "session-one";
	let idle = true;
	let queued = false;
	let auth: (signal?: AbortSignal) => Promise<string | undefined> = async () => "test-credential";
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: join(tmpdir(), "cache-project"),
		models: { current: () => model },
		get model() { return model; },
		isIdle: () => idle,
		hasPendingMessages: () => queued,
		modelRegistry: { getApiKey: (_model: unknown, _sessionId?: string, options?: { signal?: AbortSignal }) => auth(options?.signal) },
		sessionManager: {
			getBranch: () => history.map(message => ({ type: "message", message })),
			getSessionId: () => sessionId,
		},
		ui: display.ui,
		setInterval: (callback: () => void) => {
			const handle = {};
			timers.set(handle, callback);
			return handle;
		},
		setTimeout: (callback: () => void) => {
			const handle = {};
			timeouts.set(handle, callback);
			return handle;
		},
		clearTimer: (handle: object) => { timers.delete(handle); timeouts.delete(handle); },
	} as unknown as ExtensionContext;
	return {
		ctx, history, model, timers, timeouts, display, notifications: display.notifications,
		setSession(value: string) { sessionId = value; },
		setIdle(value: boolean) { idle = value; },
		setQueued(value: boolean) { queued = value; },
		setAuth(value: typeof auth) { auth = value; },
		expireRequest() { for (const callback of [...timeouts.values()]) callback(); },
		get status() { return display.status; },
		tick() { for (const callback of [...timers.values()]) callback(); },
	};
}

type Hook = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => unknown;
type EventContext = { ctx: ExtensionContext };
function harness() {
	const hooks = new Map<string, Hook[]>();
	const commands: Record<string, Command> = {};
	// Only public extension hooks/UI/timer/auth and the paid SDK boundary are supplied.
	cacheControl({
		on: (name: string, handler: Hook) => {
			hooks.set(name, [...(hooks.get(name) ?? []), handler]);
		},
		registerCommand: (name: string, options: { handler: Command }) => { commands[name] = options.handler; },
	} as unknown as ExtensionAPI);
	return {
		async emit(name: string, c: EventContext, event: Record<string, unknown> = {}) {
			let result: unknown;
			for (const handler of hooks.get(name) ?? []) result = await handler(event, c.ctx);
			return result;
		},
		async command(c: EventContext, args = "") { await commands.cache(args, c.ctx); },
	};
}

function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		model: "gpt-6.1-sol", stream: true,
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Real captured prefix" }] }],
		instructions: "Keep the exact instructions.", tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
		reasoning: { effort: "high", summary: "auto" }, parallel_tool_calls: false,
		tool_choice: "auto", prompt_cache_key: "native-cache-key",
		client_metadata: { turn_id: "foreground-turn", "x-codex-turn-state": "old-socket-state" },
		...extra,
	};
}

function warmReply(extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return assistant({
		input: 1_024, output: 0, cacheRead: 1_024, cacheWrite: 0, totalTokens: 2_048,
		cost: { input: 0.000256, output: 0, cacheRead: 0.000192, cacheWrite: 0, total: 0.000448 },
	}, { content: [], timestamp: Date.now(), ...extra });
}

function nativeReply(responseId: string, items: Array<Record<string, unknown>> = [{
	type: "message", id: "msg_native", role: "assistant", status: "completed",
	content: [{ type: "output_text", text: "Native recorded reply", annotations: [] }],
}], tokens = usage(2_048), extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return assistant(tokens, {
		responseId, providerPayload: createOpenAIResponsesHistoryPayload("openai-codex", items), ...extra,
	});
}

function nativeReplay(message: AssistantMessage): unknown[] {
	const raw = getOpenAIResponsesHistoryItems(message.providerPayload, "openai-codex");
	expect(raw).toBeDefined();
	const sanitized = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(structuredClone(raw!));
	expect(sanitized).toHaveLength(raw!.length);
	return sanitized!;
}

function isCodexModel(model: ai.Model): model is ai.Model<"openai-codex-responses"> {
	return model.api === "openai-codex-responses";
}

function isNativeApi<TApi extends ai.Api>(model: ai.Model, api: TApi): model is ai.Model<TApi> {
	return model.api === api;
}

function codexWarmInput(input: unknown[]): unknown[] {
	return [...input, { type: "configuration_update", reasoning: { effort: "low" } },
		{ role: "user", content: [{ type: "input_text", text: "Reply with only: ok" }] }];
}

function paidBoundary(frame: Record<string, unknown> = { type: "response.create", stream: true,
	client_metadata: { turn_id: "warm-turn", "x-codex-turn-metadata": "new-identity" } }) {
	const sends: Record<string, unknown>[] = [];
	const streams: ai.AssistantMessageEventStream[] = [];
	const signals: AbortSignal[] = [];
	const options: StreamOptions[] = [];
	let disposed = 0;
	provider.mockImplementation((_model, _context, opts) => {
		const events = ai.createAssistantMessageEventStream();
		streams.push(events);
		options.push(opts ?? {});
		if (opts?.signal) signals.push(opts.signal);
		opts?.providerSessionState?.set("test-transport", { close: () => { disposed++; } });
		void Promise.resolve().then(async () => {
			try {
				const outgoing = await opts?.onPayload?.(frame);
				sends.push(outgoing as Record<string, unknown>);
			} catch {
				events.push({ type: "error", reason: "error", error: warmReply({ stopReason: "error",
					errorMessage: "Raw provider detail must never appear" }) });
			}
		});
		return events;
	});
	return {
		sends, streams, signals, options,
		get disposed() { return disposed; },
		finish(message = warmReply(), index = streams.length - 1) {
			streams[index].push({ type: "done", reason: "stop", message });
		},
		push(event: AssistantMessageEvent, index = streams.length - 1) { streams[index].push(event); },
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function realRequest(h: { emit(name: string, c: EventContext, event?: Record<string, unknown>): Promise<unknown> },
	c: EventContext & { history: AssistantMessage[] },
	body = payload(), message = assistant(usage(128, 1_920, 0), { timestamp: Date.now() })) {
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", c, { payload: body });
	await h.emit("assistant_message", c, { message });
	c.history.push(message);
	await h.emit("message_end", c, { message });
	await h.emit("agent_end", c);
}

test("paid warms wait 25 minutes, stay single-flight, and leave foreground metrics intact", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	await h.emit("session_start", c);
	clock.mockReturnValue(NOW + 3_600_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(0);
	await realRequest(h, c);
	clock.mockReturnValue(NOW + 5_099_999);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(0);
	clock.mockReturnValue(NOW + 5_100_000);
	c.tick();
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	expect(c.status).toContain("warming");
	expect(c.status).toMatch(/\b94%/);
	wire.finish();
	await settle();
	expect(wire.disposed).toBe(1);
	expect(c.status).toMatch(/~30:00\b/);
	expect(c.status).toMatch(/\b94%/);
	clock.mockReturnValue(NOW + 6_599_999);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	clock.mockReturnValue(NOW + 6_600_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(2);
	wire.finish();
	await settle();
	await h.command(c, "warm");
	expect(c.notifications.at(-1)).toMatch(/2 calls.*\$0\.000896/);
	expect(c.history).toHaveLength(1);
	await h.emit("session_shutdown", c);
});

test("real requests reset paid cadence; busy and queued states defer rather than spend", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	await h.emit("session_start", c);
	await realRequest(h, c);
	clock.mockReturnValue(NOW + 1_400_000);
	await realRequest(h, c);
	clock.mockReturnValue(NOW + 1_500_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(0);
	clock.mockReturnValue(NOW + 2_900_000);
	c.setIdle(false);
	c.tick();
	await h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(0);
	c.setIdle(true);
	c.setQueued(true);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(0);
	c.setQueued(false);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	wire.finish();
	await settle();
	expect(c.status).toMatch(/~30:00\b/);
	await h.emit("session_shutdown", c);
});

test.each(["before_agent_start", "session_switch", "session_branch", "session_tree", "session_compact",
	"session_shutdown", "off", "warm off", "model", "session"] as const)(
	"%s cancels a paid request and stale completion cannot claim a fresh cache",
	async action => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		await h.emit("session_start", c);
		await realRequest(h, c);
		clock.mockReturnValue(NOW + 1_500_000);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		if (action === "off" || action === "warm off") await h.command(c, action);
		else if (action === "model") { c.model.id = "another-model"; c.tick(); }
		else if (action === "session") { c.setSession("another-session"); c.tick(); }
		else await h.emit(action, c);
		expect(wire.signals[0].aborted).toBe(true);
		wire.finish();
		await settle();
		expect(wire.disposed).toBe(1);
		expect(c.status ?? "").not.toContain("~30:00");
		clock.mockReturnValue(NOW + 4_000_000);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		await h.emit("session_shutdown", c);
	},
);

test("session changes during auth never dispatch old prefixes; shutdown also bounds unresolved auth", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	let resolveAuth: (value: string) => void = () => {};
	c.setAuth(() => new Promise<string>(resolve => { resolveAuth = resolve; }));
	await h.emit("session_start", c);
	await realRequest(h, c);
	clock.mockReturnValue(NOW + 1_500_000);
	c.tick();
	await settle();
	c.setSession("new-session-without-hook");
	resolveAuth("test-credential");
	await settle();
	expect(wire.sends).toHaveLength(0);
	expect(provider).not.toHaveBeenCalled();
	c.tick();
	await realRequest(h, c);
	clock.mockReturnValue(NOW + 3_000_000);
	c.tick();
	await settle();
	await h.emit("session_shutdown", c);
	resolveAuth("test-credential");
	await settle();
	expect(provider).not.toHaveBeenCalled();
	expect(c.timers.size + c.timeouts.size).toBe(0);
});

test.each(["restored", "small", "failed", "wrong-model", "wrong-provider", "wrong-session", "incremental", "empty-input"] as const)(
	"%s cannot spend on an absent or unsafe captured prefix",
	async scenario => {
		const h = harness();
		const c = context([assistant(usage(2_048))]);
		const wire = paidBoundary();
		await h.emit("session_start", c);
		if (scenario !== "restored") {
			const body = payload(scenario === "incremental" ? { type: "response.create", previous_response_id: "stale-response" }
				: scenario === "empty-input" ? { input: [] } : {});
			if (scenario === "wrong-model") c.model.id = "gpt-other";
			if (scenario === "wrong-provider") c.model.provider = "openai";
			await realRequest(h, c, body, assistant(usage(scenario === "small" ? 1_023 : 2_048),
				scenario === "failed" ? { stopReason: "error" } : {}));
			if (scenario === "wrong-session") c.setSession("new-session-without-hook");
		}
		clock.mockReturnValue(NOW + 1_800_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(0);
		if (scenario === "incremental") {
			expect(c.notifications.join(" ")).toContain("verified matching");
			expect(c.status).toMatch(/warm (?:pending|unavailable)/);
			expect(c.status).not.toContain("warm off");
		}
		await h.emit("session_shutdown", c);
	},
);

test("Codex full then same-agent and next-agent deltas replay native items exactly once without hidden history", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	const full = payload();
	const first = nativeReply("response_full", [
		{ type: "reasoning", id: "rs_custom", status: "completed", summary: [],
			encrypted_content: "synthetic-encrypted-custom-reasoning" },
		{ type: "custom_tool_call", id: "ctc_custom", status: "completed", call_id: "custom-one",
			name: "apply_patch", input: "*** synthetic patch ***" },
	], usage(512));
	const firstReplay = nativeReplay(first);
	expect(first.providerPayload).toMatchObject({ type: "openaiResponsesHistory", provider: "openai-codex", dt: true });
	expect(firstReplay).toEqual([
		{ type: "reasoning", summary: [], encrypted_content: "synthetic-encrypted-custom-reasoning" },
		{ type: "custom_tool_call", call_id: "custom-one", name: "apply_patch", input: "*** synthetic patch ***" },
	]);
	await h.emit("session_start", c);
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", c, { payload: full });
	const finalFull = structuredClone(full);
	await h.emit("assistant_message", c, { message: first });
	c.history.push(first);
	await h.emit("message_end", c, { message: first });

	// Tool continuation uses another provider request in the same agent lifecycle.
	const customResult = { type: "custom_tool_call_output", call_id: "custom-one", output: "Before hook" };
	const delta = payload({ type: "response.create", previous_response_id: "response_full", input: [customResult] });
	await h.emit("before_provider_request", c, { payload: delta });
	customResult.output = "Final custom result";
	(delta.input as unknown[]).push({ role: "developer", content: [{ type: "input_text", text: "Final hook input" }] });
	Object.assign(delta, {
		instructions: "Final continuation instructions", headers: { "X-Synthetic-Hook": "final-header" },
		options: { temperature: 0.25 }, tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }],
		prompt_cache_key: "final-cache-key", prompt_cache_retention: "24h", parallel_tool_calls: true,
	});
	const finalDelta = structuredClone(delta);
	await h.emit("message_end", c, { message: nativeReply("response_wrong_model", undefined, usage(2_048), { model: "gpt-other" }) });
	await h.emit("message_end", c, { message: first });
	await h.command(c, "warm now");
	expect(wire.sends).toHaveLength(0);
	const second = nativeReply("response_tools", [
		{ type: "reasoning", id: "rs_computer", status: "completed", summary: [],
			encrypted_content: "synthetic-encrypted-computer-reasoning" },
		{ type: "computer_call", id: "cu_computer", status: "completed", call_id: "computer-one",
			action: { type: "screenshot" }, pending_safety_checks: [] },
	]);
	const secondReplay = nativeReplay(second);
	expect(secondReplay[0]).toEqual({ type: "reasoning", id: "rs_computer", summary: [],
		encrypted_content: "synthetic-encrypted-computer-reasoning" });
	expect(secondReplay[1]).toMatchObject({ type: "computer_call", id: "cu_computer", call_id: "computer-one",
		action: { type: "screenshot" }, pending_safety_checks: [] });
	await h.emit("assistant_message", c, { message: second });
	c.history.push(second);
	await h.emit("message_end", c, { message: second });
	await h.emit("message_end", c, { message: second });
	const warmFirst = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(1);
	expect(wire.sends[0].input).toEqual(codexWarmInput([
		...(finalFull.input as unknown[]), ...firstReplay, ...(finalDelta.input as unknown[]),
	]));
	expect(wire.sends[0]).toMatchObject({
		instructions: delta.instructions, headers: delta.headers, options: delta.options, tools: delta.tools,
		reasoning: delta.reasoning, parallel_tool_calls: true, tool_choice: "none",
		prompt_cache_key: "final-cache-key", prompt_cache_retention: "24h",
	});
	expect(wire.sends[0].previous_response_id).toBeUndefined();
	expect(full).toEqual(finalFull);
	expect(delta).toEqual(finalDelta);
	const hiddenPayload = createOpenAIResponsesHistoryPayload("openai-codex", [{
		type: "message", id: "msg_hidden", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "Hidden output must never enter the foreground chain", annotations: [] }],
	}]);
	wire.finish(warmReply({ responseId: "response_hidden", providerPayload: hiddenPayload }));
	await warmFirst;
	expect(c.history).toEqual([first, second]);
	await h.emit("agent_end", c);

	// A new agent start keeps the committed foreground baseline, not the hidden response.
	await h.emit("before_agent_start", c);
	const next = payload({ type: "response.create", previous_response_id: "response_tools", input: [{
		type: "computer_call_output", call_id: "computer-one",
		output: { type: "input_image", image_url: "data:image/png;base64,c3ludGhldGlj" },
	}] });
	await h.emit("before_provider_request", c, { payload: next });
	const replacement = [...(next.input as unknown[]),
		{ role: "user", content: [{ type: "input_text", text: "Final replacement-array input" }] }];
	next.input = replacement;
	Object.assign(next, { instructions: "Next final instructions", headers: { "X-Synthetic-Hook": "next-header" },
		options: { temperature: 0.5 }, prompt_cache_key: "next-cache-key", prompt_cache_retention: "in_memory",
		tools: [{ type: "function", name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }] });
	const finalNext = structuredClone(next);
	const third = nativeReply("response_next");
	await h.emit("assistant_message", c, { message: third });
	c.history.push(third);
	await h.emit("message_end", c, { message: third });
	await h.emit("message_end", c, { message: third });
	await h.emit("agent_end", c);
	const warmNext = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(2);
	expect(wire.sends[1].input).toEqual(codexWarmInput([
		...(finalFull.input as unknown[]), ...firstReplay, ...(finalDelta.input as unknown[]),
		...secondReplay, ...replacement,
	]));
	expect(wire.sends[1]).toMatchObject({ instructions: next.instructions, headers: next.headers,
		options: next.options, tools: next.tools, reasoning: next.reasoning, prompt_cache_key: "next-cache-key",
		prompt_cache_retention: "in_memory", tool_choice: "none" });
	expect(wire.sends[1].previous_response_id).toBeUndefined();
	expect(next.input).toBe(replacement);
	expect(next).toEqual(finalNext);
	expect(delta).toEqual(finalDelta);
	expect(full).toEqual(finalFull);
	expect(provider.mock.calls.map(call => call[1])).toEqual([{ messages: [] }, { messages: [] }]);
	wire.finish(warmReply({ responseId: "response_hidden_next", providerPayload: hiddenPayload }));
	await warmNext;
	expect(c.history).toEqual([first, second, third]);
	await h.emit("session_shutdown", c);
});

test.each(["error", "aborted", "cut-off"] as const)(
	"delayed different-ID success cannot consume the active Codex %s request",
	async failure => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		await h.emit("session_start", c);
		const first = nativeReply("response_A", undefined, usage(512));
		await realRequest(h, c, payload(), first);

		// B is finalized on its own stream, but its notification is delayed behind
		// an earlier subscriber. Native continuation can already start full C.
		await h.emit("before_agent_start", c);
		await h.emit("before_provider_request", c, { payload: payload() });
		const second = nativeReply("response_B", undefined, usage(2_048));
		await h.emit("assistant_message", c, { message: second });
		c.history.push(second);
		const current = payload({ input: [{ role: "user", content: "Current full request C" }] });
		await h.emit("before_provider_request", c, { payload: current });
		await h.emit("message_end", c, { message: second });
		await h.emit("message_end", c, { message: second });
		const early = h.command(c, "warm now");
		await settle();
		expect(provider).not.toHaveBeenCalled();
		await early;
		if (failure !== "cut-off") {
			const failed = assistant(usage(2_048), { stopReason: failure });
			await h.emit("assistant_message", c, { message: failed });
			c.history.push(failed);
			await h.emit("message_end", c, { message: failed });
		}
		await h.emit("agent_end", c);
		clock.mockReturnValue(NOW + 3_000_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(provider).not.toHaveBeenCalled();
		expect(wire.sends).toHaveLength(0);

		// The duplicate notification for a later success is idempotent, and the
		// failed C was never committed as a parent. A real full request recovers.
		const recovered = payload({ input: [{ role: "user", content: "Recovered full wire prefix" }] });
		const reply = nativeReply("response_D", undefined, usage(2_048), { timestamp: NOW - 1 });
		await realRequest(h, c, recovered, reply);
		await h.emit("message_end", c, { message: second });
		await h.emit("message_end", c, { message: reply });
		const completion = h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(1);
		expect(wire.sends[0].input).toEqual(codexWarmInput(recovered.input as unknown[]));
		wire.finish();
		await completion;
		clock.mockReturnValue(NOW + 4_500_000);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(2);
		wire.finish();
		await settle();
		await h.emit("session_shutdown", c);
	},
);

test.each(["unknown", "mismatched"] as const)(
	"%s Codex response IDs send nothing, stay enabled, and recover on the next full request",
	async scenario => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		await h.emit("session_start", c);
		if (scenario === "mismatched") await realRequest(h, c, payload(), nativeReply("response_seed", undefined, usage(512)));
		await realRequest(h, c, payload({ previous_response_id: "response_unproven" }), nativeReply("response_rejected"));
		clock.mockReturnValue(NOW + 1_800_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(0);
		expect(provider).not.toHaveBeenCalled();
		expect(c.notifications.at(-1)).toContain("verified matching");
		expect(c.status).toMatch(/warm (?:pending|unavailable)/);
		expect(c.status).not.toContain("warm off");
		const recovered = payload({ input: [{ role: "user", content: "Recovered actual full prefix" }] });
		await realRequest(h, c, recovered, nativeReply("response_recovered"));
		const completion = h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(1);
		expect(wire.sends[0].input).toEqual(codexWarmInput(recovered.input as unknown[]));
		expect(wire.sends[0].previous_response_id).toBeUndefined();
		wire.finish();
		await completion;
		expect(c.status).not.toContain("warm off");
		await h.emit("session_shutdown", c);
	},
);

test("non-Codex incremental responses are not reconstructed from native history", async () => {
	const h = harness();
	const c = context([], { id: "gpt-6.1-sol", provider: "openai", api: "openai-responses", promptCache: { short: 300 } });
	const wire = paidBoundary();
	const extra = { provider: "openai", api: "openai-responses",
		providerPayload: createOpenAIResponsesHistoryPayload("openai", [{
			type: "message", role: "assistant", content: [{ type: "output_text", text: "Native non-Codex reply", annotations: [] }],
		}]) };
	await h.emit("session_start", c);
	await realRequest(h, c, payload(), nativeReply("response_non_codex_seed", undefined, usage(512), extra));
	await realRequest(h, c, payload({ previous_response_id: "response_non_codex_seed" }),
		nativeReply("response_non_codex_delta", undefined, usage(2_048), extra));
	clock.mockReturnValue(NOW + 1_800_000);
	c.tick();
	await h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(0);
	expect(provider).not.toHaveBeenCalled();
	expect(c.status).toMatch(/warm (?:pending|unavailable)/);
	expect(c.status).not.toContain("warm off");
	await h.emit("session_shutdown", c);
});

test.each(["previous_response_id", "model", "type", "input"] as const)(
	"post-hook Codex %s changes are revalidated before a delta can become warmable",
	async field => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		await h.emit("session_start", c);
		await realRequest(h, c, payload(), nativeReply("response_seed", undefined, usage(512)));
		await h.emit("before_agent_start", c);
		const delta = payload({ type: "response.create", previous_response_id: "response_seed" });
		await h.emit("before_provider_request", c, { payload: delta });
		delta[field] = field === "input" ? [] : field === "type" ? "response.changed"
			: field === "model" ? "gpt-other" : "response_changed_after_hook";
		const finalDelta = structuredClone(delta);
		await h.emit("assistant_message", c, { message: nativeReply("response_delta") });
		await h.emit("agent_end", c);
		clock.mockReturnValue(NOW + 1_800_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(0);
		expect(provider).not.toHaveBeenCalled();
		expect(c.notifications.at(-1)).toContain("verified matching");
		expect(c.status).not.toContain("warm off");
		expect(delta).toEqual(finalDelta);
		await h.emit("session_shutdown", c);
	},
);

test.each(["error", "aborted", "unmatched-model", "unmatched-provider", "unmatched-api",
	"session_switch", "session_branch", "session_tree", "session_compact", "session_shutdown",
	"model", "provider", "api", "session"] as const)(
	"%s discards the committed Codex baseline rather than accepting a later old-parent delta",
	async action => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		await h.emit("session_start", c);
		await realRequest(h, c, payload(), nativeReply("response_seed", undefined, usage(512)));
		if (action === "error" || action === "aborted" || action.startsWith("unmatched-")) {
			const extra: Partial<AssistantMessage> = action === "error" || action === "aborted" ? { stopReason: action }
				: action === "unmatched-model" ? { model: "gpt-other" }
				: action === "unmatched-provider" ? { provider: "openai" } : { api: "openai-responses" };
			await realRequest(h, c, payload(), nativeReply("response_not_committed", undefined, usage(2_048), extra));
		} else if (action === "model" || action === "provider" || action === "api") {
			const key = action === "model" ? "id" : action;
			const original = c.model[key];
			Object.assign(c.model, { [key]: `changed-${action}` });
			c.tick();
			Object.assign(c.model, { [key]: original });
			c.tick();
		} else if (action === "session") {
			c.setSession("changed-session");
			c.tick();
			c.setSession("session-one");
			c.tick();
		} else {
			await h.emit(action, c);
			if (action === "session_shutdown") {
				await h.emit("session_start", c);
				await h.command(c, "on");
			}
		}
		await realRequest(h, c, payload({ previous_response_id: "response_seed" }), nativeReply("response_old_parent_delta"));
		clock.mockReturnValue(NOW + 1_800_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(0);
		expect(provider).not.toHaveBeenCalled();
		expect(c.notifications.at(-1)).toContain("verified matching");
		expect(c.status).not.toContain("warm off");
		await h.emit("session_shutdown", c);
	},
);

test.each(["no-payload", "empty-output", "dropped-item", "missing-response-id"] as const)(
	"%s still warms the full request but cannot seed a guessed-text incremental chain",
	async scenario => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		const full = payload();
		const first = nativeReply("response_without_replay");
		first.content = [{ type: "text", text: "Visible text is not a native wire replay" }];
		if (scenario === "no-payload") first.providerPayload = undefined;
		else if (scenario === "missing-response-id") first.responseId = undefined;
		else if (scenario === "empty-output") first.providerPayload = createOpenAIResponsesHistoryPayload("openai-codex", [{
			type: "reasoning", encrypted_content: "synthetic-hidden-only-reasoning", summary: [],
		}]);
		else {
			const raw = getOpenAIResponsesHistoryItems(first.providerPayload, "openai-codex")!;
			raw.push({ type: "item_reference", id: "msg_unreplayable" });
			expect(raw).toHaveLength(2);
			expect(sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(structuredClone(raw))).toHaveLength(1);
		}
		await h.emit("session_start", c);
		await realRequest(h, c, full, first);
		const finalFull = structuredClone(full);
		const completion = h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(1);
		expect(wire.sends[0].input).toEqual(codexWarmInput(full.input as unknown[]));
		expect(full).toEqual(finalFull);
		wire.finish(warmReply({ responseId: "response_hidden_unusable", providerPayload:
			createOpenAIResponsesHistoryPayload("openai-codex", [{
				type: "message", role: "assistant", content: [{ type: "output_text", text: "Hidden raw reply", annotations: [] }],
			}]) }));
		await completion;
		const deltaReply = nativeReply("response_unproven_delta");
		await realRequest(h, c, payload({ previous_response_id: "response_without_replay" }), deltaReply);
		clock.mockReturnValue(NOW + 1_800_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(1);
		expect(provider).toHaveBeenCalledTimes(1);
		expect(c.status).not.toContain("warm off");
		expect(c.notifications.at(-1)).toContain("verified matching");
		expect(c.history).toEqual([first, deltaReply]);
		await h.emit("session_shutdown", c);
	},
);

test.each(["provider-error", "timeout", "missing-auth", "http-fallback", "long-text", "tool", "image", "no-usage"] as const)(
	"%s disables warming without resetting expiry or starting a retry loop",
	async scenario => {
		const h = harness();
		const c = context();
		const wire = paidBoundary(scenario === "http-fallback" ? { model: "gpt-6.1-sol", stream: true }
			: { type: "response.create", client_metadata: { turn_id: "warm-turn" } });
		if (scenario === "missing-auth") c.setAuth(async () => undefined);
		await h.emit("session_start", c);
		await realRequest(h, c);
		clock.mockReturnValue(NOW + 1_500_000);
		c.tick();
		await settle();
		if (scenario === "timeout") { c.expireRequest(); wire.finish(); }
		else if (scenario === "provider-error") wire.push({
			type: "error", reason: "error", error: warmReply({ stopReason: "error", errorMessage: "Secret raw provider detail" }),
		});
		else if (scenario === "long-text") wire.push({ type: "text_delta", contentIndex: 0, delta: "x".repeat(65),
			partial: warmReply({ content: [{ type: "text", text: "x".repeat(65) }] }) });
		else if (scenario === "tool") wire.push({ type: "toolcall_start", contentIndex: 0, partial: warmReply() });
		else if (scenario === "image") wire.finish(warmReply({ content: [{ type: "image", data: "private-image", mimeType: "image/png" }] }));
		else if (scenario === "no-usage") wire.finish(warmReply({ usage: {
			...warmReply().usage, input: 0, cacheRead: 0, totalTokens: 0,
		} }));
		await settle();
		expect(c.status).toContain("warm off");
		expect(c.status).toMatch(/~5:00\b/);
		expect(c.notifications.join(" ")).not.toMatch(/Secret|Raw provider|test-credential|Forbidden/);
		const attempted = wire.sends.length;
		clock.mockReturnValue(NOW + 7_200_000);
		c.tick();
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(attempted);
		expect(c.status).toContain("~expired");
		if (scenario === "http-fallback") expect(wire.sends).toHaveLength(0);
		await h.command(c, "warm on");
		expect(c.status).not.toContain("warm off");
		await h.emit("session_shutdown", c);
	},
);

test("manual controls work without data, reject invalid arguments, and preserve the warm-off preference", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	await h.emit("session_start", c);
	await h.command(c, "warm now");
	expect(c.notifications.at(-1)).toMatch(/pending.*0 calls.*next successful real request/);
	await h.command(c, "warm off");
	await realRequest(h, c);
	await h.command(c, "off");
	await h.command(c, "on");
	expect(c.status).toContain("warm off");
	for (const action of ["warm never", "warm on now", "off extra"]) {
		await h.command(c, action);
		expect(c.status).toContain("warm off");
		expect(c.notifications.at(-1)).toContain("Usage:");
	}
	clock.mockReturnValue(NOW + 2_000_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(0);
	await h.command(c, "warm on");
	const completion = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(1);
	wire.finish();
	await completion;
	expect(c.notifications.at(-1)).toMatch(/next in 25:00.*1 calls.*\$0\.000448/);
	await h.emit("session_shutdown", c);
	clock.mockReturnValue(NOW + 4_000_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
});

test("warm frames preserve the captured prefix/settings but use fresh transport identity", async () => {
	const h = harness();
	const c = context();
	c.model.preferWebsockets = false;
	const wire = paidBoundary();
	const captured = payload();
	await h.emit("session_start", c);
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", c, { payload: captured });
	// A later extension's in-place mutation is part of the actual outgoing prefix.
	captured.instructions = "Final instructions.";
	const message = assistant(usage(2_048), { timestamp: NOW });
	await h.emit("assistant_message", c, { message });
	c.history.push(message);
	await h.emit("message_end", c, { message });
	const completion = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(1);
	expect(wire.sends[0]).toMatchObject({
		type: "response.create", input: [...(captured.input as unknown[]),
			{ type: "configuration_update", reasoning: { effort: "low" } },
			{ role: "user", content: [{ type: "input_text", text: "Reply with only: ok" }] }], instructions: "Final instructions.",
		tools: captured.tools, reasoning: { effort: "high", summary: "auto" },
		parallel_tool_calls: false, tool_choice: "none", prompt_cache_key: "native-cache-key",
		client_metadata: { turn_id: "warm-turn", "x-codex-turn-metadata": "new-identity" },
	});
	expect(wire.sends[0].stream).toBeUndefined();
	expect(wire.sends[0].generate).toBeUndefined();
	expect(captured.input).toHaveLength(1);
	expect(captured.tool_choice).toBe("auto");
	expect((wire.sends[0].client_metadata as Record<string, unknown>)["x-codex-turn-state"]).toBeUndefined();
	expect(captured.stream).toBe(true);
	expect(provider.mock.calls[0][0].preferWebsockets).toBe(true);
	expect(c.model.preferWebsockets).toBe(false);
	expect(wire.options[0].codexSseMaxAttempts).toBe(1);
	expect(wire.options[0].providerSessionState).toBeInstanceOf(Map);
	wire.finish();
	await completion;
	await h.emit("session_shutdown", c);
});

test.each([
	{ api: "anthropic-messages", provider: "anthropic", body: {
		model: "cached-model", messages: [{ role: "user", content: [{ type: "text", text: "Actual prefix" }] }],
		system: [{ type: "text", text: "Exact system" }], tools: [{ name: "read", input_schema: { type: "object" } }],
		thinking: { type: "adaptive" }, output_config: { effort: "high" }, max_tokens: 8192,
	}, cap: "max_tokens", output: 1 },
	{ api: "bedrock-converse-stream", provider: "amazon-bedrock", body: {
		messages: [{ role: "user", content: [{ text: "Actual prefix" }] }], system: [{ text: "Exact system" }],
		toolConfig: { tools: [{ toolSpec: { name: "read", inputSchema: { json: { type: "object" } } } }] },
		inferenceConfig: { maxTokens: 8192, temperature: 0.2 }, additionalModelRequestFields: { thinking: { type: "adaptive" } },
	}, cap: "inferenceConfig.maxTokens", output: 1 },
	{ api: "openai-responses", provider: "openai", body: {
		model: "cached-model", input: [{ role: "user", content: "Actual prefix" }], instructions: "Exact system",
		tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
		reasoning: { effort: "high" }, prompt_cache_key: "same-key", max_output_tokens: 8192,
	}, cap: "max_output_tokens", output: 16 },
	{ api: "azure-openai-responses", provider: "azure-openai", body: {
		model: "cached-model", input: [{ role: "user", content: "Actual prefix" }], instructions: "Exact system",
		reasoning: { effort: "high" }, max_output_tokens: 8192,
	}, cap: "max_output_tokens", output: 16 },
	{ api: "openai-completions", provider: "openrouter", body: {
		model: "cached-model", messages: [{ role: "user", content: "Actual prefix" }],
		tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
		reasoning_effort: "high", max_completion_tokens: 8192,
	}, cap: "max_completion_tokens", output: 16 },
	{ api: "openai-completions", provider: "openai", body: {
		model: "cached-model", messages: [{ role: "user", content: "Actual prefix" }], max_tokens: 8192,
	}, cap: "max_tokens", output: 1 },
	{ api: "google-generative-ai", provider: "google", body: {
		model: "cached-model", contents: [{ role: "user", parts: [{ text: "Actual prefix" }] }],
		config: { systemInstruction: "Exact system", tools: [{ functionDeclarations: [{ name: "read" }] }],
			thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 8192 },
	}, cap: "config.maxOutputTokens", output: 1 },
	{ api: "google-vertex", provider: "google-vertex", body: {
		model: "cached-model", contents: [{ role: "user", parts: [{ text: "Actual prefix" }] }],
		config: { systemInstruction: "Exact system", maxOutputTokens: 8192 },
	}, cap: "config.maxOutputTokens", output: 1 },
	{ api: "google-gemini-cli", provider: "google-gemini-cli", body: {
		model: "cached-model", project: "actual-project", requestId: "real-turn",
		request: { contents: [{ role: "user", parts: [{ text: "Actual prefix" }] }], systemInstruction: { parts: [{ text: "Exact system" }] },
			generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } } },
	}, cap: "request.generationConfig.maxOutputTokens", output: 1 },
	// Antigravity's wire model is a thinking-level variant of the selected model.
	{ api: "google-gemini-cli", provider: "google-antigravity", body: {
		model: "cached-model-high", project: "actual-project", requestId: "real-turn", userAgent: "antigravity",
		request: { contents: [{ role: "user", parts: [{ text: "Actual prefix" }] }], systemInstruction: { parts: [{ text: "Exact system" }] },
			generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: "high" } } },
	}, cap: "request.generationConfig.maxOutputTokens", output: 1 },
] satisfies { api: string; provider: string; body: Record<string, unknown>; cap: string; output: number }[])(
	"$api heats proven sub-1024 cache prefixes on an inferred cadence without changing history or reasoning",
	async ({ api, provider: providerName, body, cap, output }: {
		api: string; provider: string; body: Record<string, unknown>; cap: string; output: number;
	}) => {
		const h = harness();
		const c = context([], { id: "cached-model", provider: providerName, api });
		if (api === "google-vertex" || api === "bedrock-converse-stream") c.setAuth(async () => undefined);
		const wire = paidBoundary({ requestId: "fresh-hidden-turn" });
		const foregroundUsage = { ...usage(12, 500), output: 9_000 };
		await h.emit("session_start", c);
		await realRequest(h, c, structuredClone(body), assistant(foregroundUsage, {
			provider: providerName, model: "cached-model", api: api as AssistantMessage["api"], timestamp: NOW,
		}));
		expect(c.status).toMatch(/\b98%/);
		expect(c.status).toContain("ttl ?");
		clock.mockReturnValue(NOW + 239_999);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(0);
		clock.mockReturnValue(NOW + 240_000);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		const sent = wire.sends[0];
		let capped: unknown = sent;
		for (const part of cap.split(".")) capped = (capped as Record<string, unknown>)[part];
		expect(capped).toBe(output);
		for (const field of ["thinking", "reasoning", "reasoning_effort", "output_config", "tools", "toolConfig", "system", "instructions", "prompt_cache_key"]) {
			expect(sent[field]).toEqual(body[field]);
		}
		if ((api === "openai-responses" || api === "azure-openai-responses" || api === "openai-completions") && Array.isArray(body.tools) && body.tools.length) {
			expect(sent.tool_choice).toBe("none");
		}
		expect(sent.input ?? sent.messages ?? sent.contents ?? (sent.request as Record<string, unknown>)?.contents)
			.toEqual(body.input ?? body.messages ?? body.contents ?? (body.request as Record<string, unknown>)?.contents);
		if (api === "google-gemini-cli") expect(sent.requestId).toBe("fresh-hidden-turn");
		const reply = warmReply({
			model: "cached-model", provider: providerName, api: api as AssistantMessage["api"],
			content: output ? [{ type: "text", text: "Hidden bounded output" }] : [],
			stopReason: "length", usage: { ...warmReply().usage, input: 12, cacheRead: 500, output, totalTokens: 512 + output },
		});
		if (output) wire.push({ type: "text_delta", contentIndex: 0, delta: "Hidden", partial: reply });
		wire.finish(reply);
		await settle();
		expect(c.status).toMatch(/\b98%/);
		expect(c.status).toContain("ttl ?");
		expect(c.status).not.toMatch(/~\d/);
		expect(c.history).toHaveLength(1);
		await h.command(c, "warm");
		expect(c.notifications.at(-1)).toMatch(/next in 4:00.*1 calls.*inferred.*TTL remains unknown/);
		expect(c.notifications.join(" ")).not.toContain("Hidden bounded output");
		clock.mockReturnValue(NOW + 479_999);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		clock.mockReturnValue(NOW + 480_000);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(2);
		wire.finish(reply);
		await settle();
		await h.emit("session_shutdown", c);
	},
);

test.each([
	{ ttl: "5m", deadline: 270_000, countdown: "~5:00" },
	{ ttl: "1h", deadline: 3_240_000, countdown: "~60:00" },
] as const)("captured Anthropic $ttl markers drive conservative native-style paid cadence", async ({ ttl, deadline, countdown }) => {
	const h = harness();
	const c = context([], { id: "claude-fable", provider: "anthropic", api: "anthropic-messages" });
	const wire = paidBoundary({});
	const body = { model: "claude-fable", max_tokens: 8192, thinking: { type: "adaptive" },
		output_config: { effort: "high" }, messages: [{ role: "user", content: [
			{ type: "text", text: "Actual prefix", cache_control: { type: "ephemeral", ttl } },
		] }] };
	await h.emit("session_start", c);
	await realRequest(h, c, body, assistant(usage(12, 500), {
		model: "claude-fable", provider: "anthropic", api: "anthropic-messages", timestamp: NOW,
	}));
	clock.mockReturnValue(NOW + deadline - 1);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(0);
	clock.mockReturnValue(NOW + deadline);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	expect(wire.sends[0]).toMatchObject({ max_tokens: 1, thinking: { type: "adaptive" }, output_config: { effort: "high" } });
	wire.finish(warmReply({ provider: "anthropic", model: "claude-fable", api: "anthropic-messages", stopReason: "length" }));
	await settle();
	expect(c.status).toContain(countdown);
	expect(c.status).toMatch(/\b98%/);
	await h.emit("session_shutdown", c);
});

test.each(["cacheless", "budget-thinking", "invalid-explicit-cache", "unsupported-api"] as const)(
	"%s reports unavailable rather than billing for fake or unsafe heating",
	async reason => {
		const h = harness();
		const model: Model = {
			id: "other-model", provider: "other-provider", api: reason === "unsupported-api" ? "ollama"
				: reason === "budget-thinking" ? "anthropic-messages"
				: reason === "invalid-explicit-cache" ? "google-generative-ai" : "openai-completions",
		};
		const c = context([], model);
		const wire = paidBoundary({});
		const body = reason === "invalid-explicit-cache"
			? { model: model.id, contents: [{ role: "user", parts: [{ text: "Real request" }] }], config: { cachedContent: "../../unsafe", maxOutputTokens: 8192 } }
			: { model: model.id, messages: [{ role: "user", content: "Real request" }], max_tokens: 8192,
				...(reason === "budget-thinking" ? { thinking: { type: "enabled", budget_tokens: 4096 } } : {}) };
		await h.emit("session_start", c);
		await realRequest(h, c, body, assistant(usage(2_048, reason === "cacheless" ? 0 : 2_048), {
			model: model.id, provider: model.provider, api: model.api as AssistantMessage["api"], timestamp: NOW,
		}));
		clock.mockReturnValue(NOW + 3_600_000);
		c.tick();
		await h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(0);
		expect(c.status).toContain("warm unavailable");
		expect(c.notifications.at(-1)).toMatch(/unavailable.*0 calls.*Unavailable:/);
		await h.emit("session_shutdown", c);
	},
);

test("idle provider hooks cannot replace a real prefix, and TUI native warm decisions prevent duplicate billing", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	await h.emit("session_start", c);
	await realRequest(h, c);
	expect(await h.emit("cache_warming_decision", c)).toEqual({ action: "stop" });
	await h.emit("before_provider_request", c, { payload: payload({ input: [{ role: "user", content: "Native hidden replay" }] }) });
	const completion = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(1);
	expect(wire.sends[0].input).toEqual([
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Real captured prefix" }] },
		{ type: "configuration_update", reasoning: { effort: "low" } },
		{ role: "user", content: [{ type: "input_text", text: "Reply with only: ok" }] },
	]);
	wire.finish();
	await completion;
	await h.command(c, "off");
	expect(await h.emit("cache_warming_decision", c)).toEqual({ action: "stop" });
	c.ctx.hasUI = false;
	expect(await h.emit("cache_warming_decision", c)).toBeUndefined();
	c.ctx.hasUI = true;
	await h.emit("session_shutdown", c);
});

test("Gemini upkeep replaces old SDK auth/abort metadata without changing cache-affecting configuration", async () => {
	const h = harness();
	const c = context([], { id: "gemini-cached", provider: "google", api: "google-generative-ai" });
	const old = new AbortController();
	old.abort();
	const wire = paidBoundary({ config: { httpOptions: { headers: { Authorization: "fresh-test-auth" } } } });
	const body = { model: "gemini-cached", contents: [{ role: "user", parts: [{ text: "Actual prefix" }] }],
		config: { systemInstruction: "Actual system", tools: [{ functionDeclarations: [{ name: "read" }] }],
			thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 8192,
			abortSignal: old.signal, httpOptions: { headers: { Authorization: "old-test-auth" } } } };
	await h.emit("session_start", c);
	await realRequest(h, c, body, assistant(usage(12, 500), {
		model: "gemini-cached", provider: "google", api: "google-generative-ai", timestamp: NOW,
	}));
	const completion = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(1);
	const config = wire.sends[0].config as Record<string, unknown>;
	expect(config.abortSignal).toBe(wire.signals[0]);
	expect((config.abortSignal as AbortSignal).aborted).toBe(false);
	expect(config.httpOptions).toEqual({ headers: { Authorization: "fresh-test-auth" } });
	expect(config.thinkingConfig).toEqual({ thinkingBudget: 0 });
	expect(config.tools).toEqual([{ functionDeclarations: [{ name: "read" }] }]);
	wire.finish(warmReply({ model: "gemini-cached", provider: "google", api: "google-generative-ai" }));
	await completion;
	expect(c.notifications.join(" ")).not.toMatch(/old-test-auth|fresh-test-auth/);
	await h.emit("session_shutdown", c);
});

test("per-request totals include writes, exclude output, and replace rather than accumulate", async () => {
	const h = harness();
	const c = context([assistant(usage(4, 3, 3))]);
	await h.emit("session_start", c);
	expect(c.status).toMatch(/\b30%/);
	expect(c.status).toContain("ttl ?");
	c.history.push(assistant(usage(100, 200, 700)));
	await h.emit("agent_end", c);
	expect(c.status).toMatch(/\b20%/);
});

test("zero reported input is no usage, while writes without reads report zero reuse", async () => {
	const h = harness();
	const c = context([assistant()]);
	await h.emit("session_start", c);
	expect(c.status).toBeDefined();
	expect(c.status).not.toMatch(/\d+%|ttl|~/);
	await h.emit("message_end", c, { message: assistant(usage(100, 0, 300)) });
	expect(c.status).toMatch(/\b0%/);
	expect(c.status).toContain("ttl ?");
});

test("Sol's 30-minute assumption starts at send time, not response completion", async () => {
	const h = harness();
	const c = context([assistant(usage(100, 600, 324), {
		timestamp: NOW - 120_000, completedAt: NOW - 10_000, duration: 110_000,
	})]);
	await h.emit("session_start", c);
	expect(c.status).toMatch(/~28:00\b/);
	clock.mockReturnValue(NOW + 1_679_000);
	c.tick();
	expect(c.status).toMatch(/~0:01\b/);
	clock.mockReturnValue(NOW + 1_680_000);
	c.tick();
	expect(c.status).toMatch(/~expired/);
});

test.each([
	{ reason: "1023 prompt tokens", tokens: usage(100, 600, 323), extra: {} },
	{ reason: "failed response", tokens: usage(1_024), extra: { stopReason: "error" } },
	{ reason: "aborted response", tokens: usage(1_024), extra: { stopReason: "aborted" } },
	{ reason: "another Codex model", tokens: usage(1_024), extra: { model: "gpt-other" } },
	{ reason: "another provider", tokens: usage(1_024), extra: { provider: "openai" } },
] satisfies { reason: string; tokens: AssistantMessage["usage"]; extra: Partial<AssistantMessage> }[])(
	"$reason does not gain an assumed expiry",
	async ({ tokens, extra }) => {
		const h = harness();
		const message = assistant(tokens, extra);
		const c = context([message], { id: message.model, provider: message.provider });
		await h.emit("session_start", c);
		clock.mockReturnValue(NOW + 7_200_000);
		c.tick();
		expect(c.status).toMatch(/ttl \?/);
	},
);

test.each([
	{ tier: "ephemeral5m", ttl: "short", seconds: 300, left: "4:48" },
	{ tier: "ephemeral1h", ttl: "long", seconds: 3_600, left: "59:48" },
] as const)("reported $ttl writes have an estimated countdown and expiry", async ({ tier, ttl, seconds, left }) => {
	const h = harness();
	const tokens = { ...usage(100, 0, 300), cttl: { [tier]: 300 } };
	const c = context([assistant(tokens, {
		provider: "anthropic", model: "claude", completedAt: NOW - 2_000,
		timestamp: NOW - 12_000, duration: 10_000,
	})], { provider: "anthropic", id: "claude", promptCache: { [ttl]: seconds } });
	await h.emit("session_start", c);
	expect(c.status).toMatch(new RegExp(`~${left}\\b`));
	clock.mockReturnValue(NOW + seconds * 1_000 - 13_000);
	c.tick();
	expect(c.status).toMatch(/~0:01\b/);
	clock.mockReturnValue(NOW + seconds * 1_000 - 12_000);
	c.tick();
	expect(c.status).toMatch(/~expired/);
});

test("ambiguous tiers and missing send timing do not imply expiry", async () => {
	const h = harness();
	const c = context([], {
		provider: "anthropic", id: "claude", promptCache: { short: 300, long: 3_600 },
	});
	await h.emit("session_start", c);
	for (const message of [
		assistant(usage(100, 0, 300), { provider: "anthropic", model: "claude" }),
		assistant({ ...usage(100, 0, 300), cttl: { ephemeral5m: 100, ephemeral1h: 200 } }, {
			provider: "anthropic", model: "claude",
		}),
		assistant({ ...usage(100, 0, 300), cttl: { ephemeral5m: 300 } }, {
			provider: "anthropic", model: "claude", timestamp: Number.NaN,
		}),
	]) {
		await h.emit("message_end", c, { message });
		expect(c.status).toMatch(/ttl \?/);
	}
});

test("session changes discard old metrics and tear down the old context timer", async () => {
	const h = harness();
	const old = context([assistant(usage(100, 600, 300))]);
	const fresh = context([], undefined, old.display);
	await h.emit("session_start", old);
	expect(old.status).toMatch(/\b60%/);
	expect(old.timers.size).toBe(1);
	await h.emit("session_switch", fresh);
	expect(old.timers.size).toBe(0);
	expect(fresh.timers.size).toBe(1);
	expect(fresh.status).toBeDefined();
	expect(fresh.status).not.toMatch(/\d+%|ttl|~/);
	fresh.history.push(assistant(usage(75, 25, 0)));
	for (const event of ["session_branch", "session_tree", "session_compact"]) {
		await h.emit(event, fresh);
		expect(fresh.status).toMatch(/\b25%/);
		expect(fresh.timers.size).toBe(1);
		expect(old.timers.size).toBe(0);
	}
	await h.emit("session_shutdown", fresh);
	expect(fresh.timers.size).toBe(0);
	expect(fresh.status).toBeUndefined();
});

test("bare and on commands show native cache status; off keeps it hidden through later hooks", async () => {
	const h = harness();
	const c = context([assistant(usage(100, 600, 300))]);
	await h.emit("session_start", c);
	expect(c.status).toMatch(/\b60%/);
	for (const action of ["", "", "on", "on"]) {
		await h.command(c, action);
		expect(c.status).toMatch(/\b60%/);
		expect(c.timers.size).toBe(1);
	}
	await h.command(c, "off");
	expect(c.status).toBeUndefined();
	c.history.push(assistant(usage(50, 50, 0)));
	await h.emit("message_end", c, { message: c.history[c.history.length - 1] });
	await h.emit("turn_end", c);
	c.tick();
	expect(c.status).toBeUndefined();
	expect(c.timers.size).toBe(0);
	for (const action of ["", "on"]) {
		await h.command(c, action);
		expect(c.status).toMatch(/\b50%/);
		expect(c.timers.size).toBe(1);
		await h.command(c, "off");
		expect(c.status).toBeUndefined();
		expect(c.timers.size).toBe(0);
	}
	expect(c.notifications).toEqual([]);
});

test("message events render immediately while settled metrics come from session history", async () => {
	const h = harness();
	const c = context([assistant(usage(100, 600, 300))]);
	await h.emit("session_start", c);
	expect(c.status).toMatch(/\b60%/);
	await h.emit("message_end", c, { message: assistant(usage(10, 90, 0)) });
	expect(c.status).toMatch(/\b90%/);
	await h.emit("turn_end", c);
	expect(c.status).toMatch(/\b60%/);
	c.history.push(assistant(usage(75, 25, 0)));
	await h.emit("agent_end", c);
	expect(c.status).toMatch(/\b25%/);
});

test("timer repaint follows current model without borrowing another model's metrics", async () => {
	const h = harness();
	const c = context([assistant(usage(100, 600, 300))]);
	await h.emit("session_start", c);
	c.model.id = "gpt-other";
	c.tick();
	expect(c.status).toBeDefined();
	expect(c.status).not.toMatch(/\d+%|ttl|~/);
	c.model.id = "gpt-6.1-sol";
	c.tick();
	expect(c.status).toMatch(/\b60%/);
	expect(c.timers.size).toBe(1);
});

test.each(["unicode", "nerd"] as const)("live %s-to-ASCII switch preserves cache metrics and controls", async preset => {
	const h = harness();
	const c = context([assistant(usage(256, 512, 256))]);
	c.display.setSymbolPreset(preset);
	await h.emit("session_start", c);
	expect(c.status).toMatch(/\b50%/);
	expect(c.status).toMatch(/~29:50\b/);

	c.display.setSymbolPreset("ascii");
	c.tick();
	expect(c.status).toMatch(/^[\x00-\x7F]+$/);
	expect(c.status).toMatch(/\b50%/);
	expect(c.status).toMatch(/~29:50\b/);
	await h.command(c, "off");
	expect(c.status).toBeUndefined();
	await h.command(c, "on");
	expect(c.status).toMatch(/^[\x00-\x7F]+$/);
	expect(c.status).toMatch(/\b50%/);

	c.history.length = 0;
	await h.emit("session_switch", c);
	expect(c.status).toMatch(/^[\x00-\x7F]+$/);
	expect(c.status).not.toMatch(/\d+%|ttl|~/);
	await h.emit("message_end", c, { message: assistant(usage(100, 200, 700)) });
	expect(c.status).toMatch(/^[\x00-\x7F]+$/);
	expect(c.status).toMatch(/\b20%/);
	expect(c.status).toContain("ttl ?");
});


test("explicit Gemini renewals preserve the chosen storage duration and foreground reads never postpone fixed expiry", async () => {
	const h = harness();
	const c = context([], { id: "gemini-cached", provider: "google", api: "google-generative-ai" });
	const name = "cachedContents/existing-native-cache";
	let expiry = NOW + 3_600_000;
	const requests: { url: string; init?: RequestInit }[] = [];
	cacheHttp.mockImplementation(isolatedFetch(async (url, init) => {
		requests.push({ url: String(url), init });
		if (init?.method === "PATCH") {
			expiry = NOW + 6_840_000;
			return Response.json({ name, expireTime: new Date(expiry).toISOString() });
		}
		return Response.json({ name, model: "models/gemini-cached", expireTime: new Date(expiry).toISOString(),
			updateTime: new Date(expiry - 3_600_000).toISOString() });
	}));
	const body = { model: "gemini-cached", contents: [], config: { cachedContent: name, maxOutputTokens: 8192 } };
	const foregroundReply = () => assistant(usage(12, 500), {
		model: "gemini-cached", provider: "google", api: "google-generative-ai", timestamp: Date.now(),
	});
	await h.emit("session_start", c);
	await realRequest(h, c, body, foregroundReply());
	c.tick();
	await settle();
	expect(requests).toHaveLength(1);
	expect(requests[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/cachedContents/existing-native-cache");
	expect(c.status).toContain("~60:00");
	clock.mockReturnValue(NOW + 3_000_000);
	await realRequest(h, c, body, foregroundReply());
	c.tick();
	await settle();
	expect(requests).toHaveLength(2);
	expect(c.status).toContain("~10:00");
	clock.mockReturnValue(NOW + 3_239_999);
	c.tick();
	await settle();
	expect(requests).toHaveLength(2);
	clock.mockReturnValue(NOW + 3_240_000);
	c.tick();
	await settle();
	expect(requests).toHaveLength(4);
	expect(requests[3].init?.method).toBe("PATCH");
	expect(requests[3].url).toContain("?updateMask=ttl");
	expect(requests[3].init?.body).toBe('{"ttl":"3600s"}');
	expect(c.status).toContain("~60:00");
	expect(c.status).toMatch(/\b98%/);
	expect(provider).not.toHaveBeenCalled();
	expect(c.history).toHaveLength(2);
	await h.command(c, "warm");
	expect(c.notifications.at(-1)).toMatch(/1 calls.*\$0\.000000.*1 unpriced.*storage extension is billed.*price is unavailable/);
	await h.emit("session_shutdown", c);
	clock.mockReturnValue(NOW + 7_200_000);
	c.tick();
	await settle();
	expect(requests).toHaveLength(4);
});

test("Vertex explicit-cache upkeep delegates ambient auth and uses the native regional endpoint", async () => {
	const h = harness();
	const c = context([], { id: "gemini-cached", provider: "google-vertex", api: "google-vertex", headers: { "X-Custom": "native-header" } });
	c.setAuth(async () => undefined);
	const name = "projects/native-project/locations/us-central1/cachedContents/native-cache";
	const requests: { url: string; init?: RequestInit }[] = [];
	cacheHttp.mockImplementation(isolatedFetch(async (url, init) => {
		requests.push({ url: String(url), init });
		return Response.json(init?.method === "PATCH"
			? { name, expireTime: new Date(NOW + 1_200_000).toISOString() }
			: { name, model: "projects/native-project/locations/us-central1/publishers/google/models/gemini-cached",
				expireTime: new Date(NOW + 600_000).toISOString(), createTime: new Date(NOW - 600_000).toISOString() });
	}));
	await h.emit("session_start", c);
	await realRequest(h, c, { model: "gemini-cached", contents: [], config: { cachedContent: name } }, assistant(usage(12, 500), {
		model: "gemini-cached", provider: "google-vertex", api: "google-vertex", timestamp: NOW,
	}));
	await h.command(c, "warm now");
	expect(vertexAuth).toHaveBeenCalledTimes(1);
	expect(requests).toHaveLength(2);
	expect(requests[0].url).toBe("https://us-central1-aiplatform.googleapis.com/v1/projects/native-project/locations/us-central1/cachedContents/native-cache");
	expect(new Headers(requests[0].init?.headers).get("Authorization")).toBe("Bearer native-test-access");
	expect(new Headers(requests[0].init?.headers).get("X-Custom")).toBe("native-header");
	expect(requests[1].init?.body).toBe('{"ttl":"1200s"}');
	expect(c.status).toContain("~20:00");
	expect(c.notifications.join(" ")).not.toContain("native-test-access");
	expect(provider).not.toHaveBeenCalled();
	await h.emit("session_shutdown", c);
});

test.each([
	{ stage: "GET", action: "session" }, { stage: "GET", action: "off" },
	{ stage: "PATCH", action: "off" }, { stage: "PATCH", action: "shutdown" },
] as const)("cancelling explicit-cache $stage during $action cannot dispatch or commit a stale renewal", async ({ stage, action }) => {
	const h = harness();
	const c = context([], { id: "gemini-cached", provider: "google", api: "google-generative-ai" });
	const name = "cachedContents/native-cache";
	let release: (response: Response) => void = () => {};
	const requests: RequestInit[] = [];
	cacheHttp.mockImplementation(isolatedFetch(async (_url, init = {}) => {
		requests.push(init);
		if ((init.method ?? "GET") === stage) return new Promise<Response>(resolve => { release = resolve; });
		return Response.json({ name, model: "models/gemini-cached", expireTime: new Date(NOW + 30_000).toISOString(),
			updateTime: new Date(NOW - 3_570_000).toISOString() });
	}));
	await h.emit("session_start", c);
	await realRequest(h, c, { model: "gemini-cached", contents: [], config: { cachedContent: name } }, assistant(usage(12, 500), {
		model: "gemini-cached", provider: "google", api: "google-generative-ai", timestamp: NOW,
	}));
	const completion = h.command(c, "warm now");
	await settle();
	if (action === "session") { c.setSession("fresh-session"); await h.emit("session_switch", c); }
	else if (action === "off") await h.command(c, "off");
	else await h.emit("session_shutdown", c);
	expect(requests.at(-1)?.signal?.aborted).toBe(true);
	release(Response.json({ name, model: "models/gemini-cached", expireTime: new Date(NOW + 3_600_000).toISOString(),
		updateTime: new Date(NOW).toISOString() }));
	await completion;
	await settle();
	expect(requests.filter(request => request.method === "PATCH")).toHaveLength(stage === "PATCH" ? 1 : 0);
	expect(c.status ?? "").not.toContain("~60:00");
	expect(provider).not.toHaveBeenCalled();
	await h.emit("session_shutdown", c);
});

test.each(["metadata-error", "invalid-retention", "unchanged-expiry", "wrong-resource"] as const)(
	"explicit-cache $reason stops on failed lease proof without a future billing loop",
	async reason => {
		const h = harness();
		const c = context([], { id: "gemini-cached", provider: "google", api: "google-generative-ai" });
		const name = "cachedContents/native-cache";
		cacheHttp.mockImplementation(isolatedFetch(async (_url, init) => {
			if (reason === "metadata-error") return new Response("Secret raw provider error", { status: 403 });
			if (init?.method === "PATCH") return Response.json({
				name: reason === "wrong-resource" ? "cachedContents/different-resource" : name,
				expireTime: new Date(NOW + 30_000).toISOString(),
			});
			return Response.json({ name, model: "models/gemini-cached",
				expireTime: new Date(NOW + 30_000).toISOString(),
				updateTime: reason === "invalid-retention" ? "not-a-timestamp" : new Date(NOW - 3_570_000).toISOString() });
		}));
		await h.emit("session_start", c);
		await realRequest(h, c, { model: "gemini-cached", contents: [], config: { cachedContent: name } }, assistant(usage(12, 500), {
			model: "gemini-cached", provider: "google", api: "google-generative-ai", timestamp: NOW,
		}));
		await h.command(c, "warm now");
		expect(c.status).toContain("warm off");
		expect(c.status).toContain("ttl ?");
		expect(c.notifications.join(" ")).not.toContain("Secret raw provider error");
		const charged = cacheHttp.mock.calls.length;
		clock.mockReturnValue(NOW + 7_200_000);
		c.tick();
		c.tick();
		await settle();
		expect(cacheHttp.mock.calls).toHaveLength(charged);
		expect(provider).not.toHaveBeenCalled();
		await h.emit("session_shutdown", c);
	},
);

test.each([undefined, "30m", -1] as const)("Ollama keeps the exact prefix and %s residency policy under a one-token upkeep cap", async keepAlive => {
	const h = harness();
	const c = context([], { id: "local-model", provider: "ollama", api: "ollama-chat" });
	c.setAuth(async () => undefined);
	const wire = paidBoundary({});
	const body = { model: "local-model", messages: [{ role: "user", content: "Real KV-cache prefix" }], stream: true,
		think: true, options: { num_predict: 8192, temperature: 0.2 },
		...(keepAlive === undefined ? {} : { keep_alive: keepAlive }) };
	await h.emit("session_start", c);
	await realRequest(h, c, body, assistant(usage(500), {
		model: "local-model", provider: "ollama", api: "ollama-chat", timestamp: NOW,
	}));
	clock.mockReturnValue(NOW + 240_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	expect(wire.sends[0].options).toEqual({ num_predict: 1, temperature: 0.2 });
	expect(wire.sends[0].messages).toEqual([{ role: "user", content: "Real KV-cache prefix" }]);
	expect(wire.sends[0].think).toBe(true);
	expect(wire.sends[0].keep_alive).toBe(keepAlive);
	const reply = warmReply({ model: "local-model", provider: "ollama", api: "ollama-chat",
		content: [{ type: "thinking", thinking: "Hidden thought" }], stopReason: "length",
		usage: { ...warmReply().usage, input: 500, output: 1, cacheRead: 0, totalTokens: 501 } });
	wire.push({ type: "thinking_delta", contentIndex: 0, delta: "Hidden thought", partial: reply });
	wire.finish(reply);
	await settle();
	expect(c.status).toContain("ttl ?");
	expect(c.status).toContain("warm miss");
	expect(c.status).not.toContain("warm off");
	expect(c.history).toHaveLength(1);
	await h.command(c, "off");
	clock.mockReturnValue(NOW + 480_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	await h.emit("session_shutdown", c);
});

test("a continuing foreground provider request aborts upkeep before its new prefix can be confused with stale success", async () => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	await h.emit("session_start", c);
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", c, { payload: payload() });
	const first = assistant(usage(128, 1_920), { timestamp: NOW });
	await h.emit("assistant_message", c, { message: first });
	c.history.push(first);
	await h.emit("message_end", c, { message: first });
	clock.mockReturnValue(NOW + 1_500_000);
	const completion = h.command(c, "warm now");
	await settle();
	expect(wire.sends).toHaveLength(1);
	await h.emit("before_provider_request", c, { payload: payload({ input: [{ role: "user", content: "Continued real prefix" }] }) });
	expect(wire.signals[0].aborted).toBe(true);
	wire.finish();
	await completion;
	expect(c.status).toMatch(/~5:00\b/);
	expect(c.status).toMatch(/\b94%/);
	expect(c.status).toContain("warm pending");
	clock.mockReturnValue(NOW + 3_000_000);
	c.tick();
	await settle();
	expect(wire.sends).toHaveLength(1);
	await h.emit("session_shutdown", c);
});

test("explicit cache requests resolve live native headers instead of reusing a foreground-bound credential", async () => {
	const h = harness();
	const c = context([], { id: "gemini-cached", provider: "google", api: "google-generative-ai" });
	const name = "cachedContents/header-refresh";
	const headerSignals: (AbortSignal | undefined)[] = [];
	c.model.resolveHeaders = async signal => {
		headerSignals.push(signal);
		return { "X-Native-Credential": "fresh-native-value" };
	};
	const resolved = { ...c.ctx.models.current()!, headers: { "X-Native-Credential": "expired-bound-value" }, resolveHeaders: undefined };
	const bound = { ctx: { ...c.ctx, model: resolved, models: { ...c.ctx.models, current: () => resolved } } };
	const requests: RequestInit[] = [];
	cacheHttp.mockImplementation(isolatedFetch(async (_url, init) => {
		requests.push(init ?? {});
		return Response.json({ name, model: "models/gemini-cached",
			expireTime: new Date(NOW + 3_600_000).toISOString(), updateTime: new Date(NOW).toISOString() });
	}));
	await h.emit("session_start", c);
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", bound, { payload: { model: "gemini-cached", contents: [],
		config: { cachedContent: name, maxOutputTokens: 8192 } } });
	const message = assistant(usage(12, 500), { model: "gemini-cached", provider: "google", api: "google-generative-ai", timestamp: NOW });
	await h.emit("assistant_message", c, { message });
	c.history.push(message);
	await h.emit("message_end", c, { message });
	await h.emit("agent_end", c);
	c.tick();
	await settle();
	expect(requests).toHaveLength(1);
	expect(new Headers(requests[0].headers).get("x-native-credential")).toBe("fresh-native-value");
	expect(new Headers(requests[0].headers).get("x-goog-api-key")).toBe("test-credential");
	expect(headerSignals).toHaveLength(1);
	expect(headerSignals[0]?.aborted).toBe(false);
	expect(c.status).toContain("~60:00");
	expect(c.notifications.join(" ")).not.toMatch(/fresh-native-value|expired-bound-value/);
	await h.emit("session_shutdown", c);
});

test.each(["off", "timeout", "session_shutdown"] as const)("late native header resolution cannot dispatch after %s", async action => {
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	let release!: (headers: Record<string, string>) => void;
	const pending = new Promise<Record<string, string>>(resolve => { release = resolve; });
	let headerSignal: AbortSignal | undefined;
	c.model.resolveHeaders = signal => { headerSignal = signal; return pending; };
	await h.emit("session_start", c);
	await realRequest(h, c);
	const completion = h.command(c, "warm now");
	await settle();
	expect(headerSignal?.aborted).toBe(false);
	expect(wire.sends).toHaveLength(0);
	if (action === "off") await h.command(c, "off");
	else if (action === "timeout") c.expireRequest();
	else await h.emit("session_shutdown", c);
	await completion;
	expect(headerSignal?.aborted).toBe(true);
	expect(c.timeouts.size).toBe(0);
	release({ Authorization: "late-private-header" });
	await settle();
	expect(wire.sends).toHaveLength(0);
	expect(provider.mock.calls).toHaveLength(0);
	expect(c.notifications.join(" ")).not.toContain("late-private-header");
	await h.emit("session_shutdown", c);
});

test.each([
	{ policy: "0ms", deadline: undefined }, { policy: "0h0m0s", deadline: undefined },
	{ policy: "-0ms", deadline: undefined }, { policy: ".1ns", deadline: undefined },
	{ policy: 0, deadline: undefined }, { policy: ".5s", deadline: undefined },
	{ policy: "1.2s", deadline: undefined },
	{ policy: "30s", deadline: 20_000 }, { policy: 30, deadline: 20_000 },
	{ policy: "1m30s", deadline: 80_000 }, { policy: "5s", deadline: 4_000 },
	{ policy: -1, deadline: 240_000 }, { policy: "-1", deadline: 240_000 },
	{ policy: "-30s", deadline: 240_000 }, { policy: undefined, deadline: 240_000 },
])("Ollama $policy residency bounds actual dispatch without claiming a KV lease", async ({ policy, deadline }) => {
	const h = harness();
	const c = context([], { id: "local-model", provider: "ollama", api: "ollama-chat" });
	const wire = paidBoundary({});
	const body: Record<string, unknown> = { model: "local-model", messages: [{ role: "user", content: "Actual local prefix" }],
		options: { num_predict: 8192 }, ...(policy === undefined ? {} : { keep_alive: policy }) };
	await h.emit("session_start", c);
	await realRequest(h, c, body, assistant(usage(500), { model: "local-model", provider: "ollama", api: "ollama-chat", timestamp: NOW }));
	expect(c.status).toContain("ttl ?");
	if (deadline === undefined) {
		clock.mockReturnValue(NOW + 3_600_000);
		c.tick();
		await settle();
		await h.command(c, "warm now");
		expect(wire.sends).toHaveLength(0);
		expect(c.status).toContain("warm unavailable");
		expect(c.notifications.at(-1)).toMatch(/zero native residency|too short.*one-second/);
	} else {
		clock.mockReturnValue(NOW + deadline - 1);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(0);
		clock.mockReturnValue(NOW + deadline);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		expect(wire.sends[0].keep_alive).toBe(policy);
		expect(wire.sends[0].messages).toEqual(body.messages);
		expect(wire.sends[0].options).toEqual({ num_predict: 1 });
		wire.finish(warmReply({ model: "local-model", provider: "ollama", api: "ollama-chat",
			stopReason: "length", content: [{ type: "text", text: "Discarded local output" }],
			usage: { ...warmReply().usage, input: 500, cacheRead: 0, output: 1, totalTokens: 501 } }));
		await settle();
		clock.mockReturnValue(NOW + deadline * 2 - 1);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		await h.command(c, "warm");
		expect(c.notifications.at(-1)).toMatch(/TTL remains unknown|KV TTL remains unknown/);
		expect(c.status).not.toMatch(/~\d/);
	}
	await h.emit("session_shutdown", c);
});

test.each(["openai-responses", "azure-openai-responses", "openai-completions"] as const)(
	"%s disables tools using cache-safe choice without deleting cached definitions",
	async api => {
		const h = harness();
		const c = context([], { id: "cached-model", provider: "openai", api });
		const wire = paidBoundary({});
		const tools = api === "openai-completions"
			? [{ type: "function", function: { name: "read", parameters: { type: "object" } } }]
			: [{ type: "image_generation" }, { type: "web_search" }, { type: "mcp", server_label: "native-server" }];
		const body: Record<string, unknown> = api === "openai-completions"
			? { model: "cached-model", messages: [{ role: "user", content: "Actual prefix" }], tools, tool_choice: "required",
				parallel_tool_calls: false, reasoning_effort: "high", max_completion_tokens: 8192 }
			: { model: "cached-model", input: [{ role: "user", content: "Actual prefix" }], tools, tool_choice: "required",
				parallel_tool_calls: false, reasoning: { effort: "high" }, max_output_tokens: 8192 };
		await h.emit("session_start", c);
		await realRequest(h, c, body, assistant(usage(12, 500), { model: "cached-model", provider: "openai", api, timestamp: NOW }));
		const completion = h.command(c, "warm now");
		await settle();
		expect(wire.sends).toHaveLength(1);
		expect(wire.sends[0]).toMatchObject({ tools, tool_choice: "none", parallel_tool_calls: false });
		expect(wire.sends[0].reasoning).toEqual(body.reasoning);
		expect(wire.sends[0].reasoning_effort).toEqual(body.reasoning_effort);
		expect(body.tool_choice).toBe("required");
		wire.finish(warmReply({ model: "cached-model", provider: "openai", api }));
		await completion;
		expect(c.history).toHaveLength(1);
		await h.emit("session_shutdown", c);
	},
);

test.each([
	{ api: "google-generative-ai", settings: { tools: [{ googleSearch: {} }] } },
	{ api: "google-vertex", settings: { tools: [{ codeExecution: {} }] } },
	{ api: "google-gemini-cli", settings: { tools: [{ urlContext: {} }] } },
	{ api: "google-generative-ai", settings: { responseModalities: ["TEXT", "IMAGE"] } },
	{ api: "google-vertex", settings: { responseModalities: ["AUDIO"] } },
])("final $api server-side tools or non-text modes do not start unbounded hidden work", async ({ api, settings }) => {
	const h = harness();
	const c = context([], { id: "cached-model", provider: "google", api });
	const wire = paidBoundary({});
	const contents = [{ role: "user", parts: [{ text: "Actual prefix" }] }];
	const body: Record<string, unknown> = { model: "cached-model", contents, config: { maxOutputTokens: 8192 },
		request: { contents, generationConfig: { maxOutputTokens: 8192 } } };
	await h.emit("session_start", c);
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", c, { payload: body });
	// A later in-place transformer must not bypass safety on the actual final payload.
	if (api === "google-gemini-cli") Object.assign(body.request as Record<string, unknown>, settings);
	else Object.assign(body.config as Record<string, unknown>, settings);
	const message = assistant(usage(12, 500), { model: "cached-model", provider: "google", api: api as AssistantMessage["api"], timestamp: NOW });
	await h.emit("assistant_message", c, { message });
	c.history.push(message);
	await h.emit("message_end", c, { message });
	await h.emit("agent_end", c);
	clock.mockReturnValue(NOW + 240_000);
	c.tick();
	await settle();
	await h.command(c, "warm now");
	expect(wire.sends).toHaveLength(0);
	expect(c.status).toContain("warm unavailable");
	expect(c.notifications.at(-1)).toMatch(/server-side tools|non-text generation/);
	await h.emit("session_shutdown", c);
});

test("explicit cache storage upkeep remains non-generative with non-text settings and stored server tools", async () => {
	const h = harness();
	const c = context([], { id: "cached-model", provider: "google", api: "google-generative-ai" });
	const name = "cachedContents/non-generative-upkeep";
	const requests: RequestInit[] = [];
	cacheHttp.mockImplementation(isolatedFetch(async (_url, init) => {
		requests.push(init ?? {});
		return Response.json({ name, model: "models/cached-model", updateTime: new Date(NOW).toISOString(),
			expireTime: new Date(NOW + 3_600_000).toISOString(), tools: [{ googleSearch: {} }] });
	}));
	await h.emit("session_start", c);
	await realRequest(h, c, { model: "cached-model", contents: [], config: { cachedContent: name,
		responseModalities: ["IMAGE"] } }, assistant(usage(12, 500), {
		model: "cached-model", provider: "google", api: "google-generative-ai", timestamp: NOW,
	}));
	c.tick();
	await settle();
	expect(requests).toHaveLength(1);
	expect(provider.mock.calls).toHaveLength(0);
	expect(c.status).toContain("~60:00");
	await h.emit("session_shutdown", c);
});

test.each(["constructor", "toString", "__proto__"] as const)("inherited %s properties are not supported replay APIs", async api => {
	const h = harness();
	const c = context([], { id: "cached-model", provider: "other", api });
	const wire = paidBoundary({});
	await h.emit("session_start", c);
	await realRequest(h, c, { model: "cached-model", messages: [{ role: "user", content: "Actual prefix" }] },
		assistant(usage(12, 500), { model: "cached-model", provider: "other", api, timestamp: NOW }));
	clock.mockReturnValue(NOW + 240_000);
	c.tick();
	await settle();
	await h.command(c, "warm now");
	expect(wire.sends).toHaveLength(0);
	expect(c.status).toContain("warm unavailable");
	await h.emit("session_shutdown", c);
});

test.each(["conv-native-resource", { id: "conv-native-resource" }])("linked server conversations %p are not appended by hidden upkeep", async conversation => {
	const h = harness();
	const c = context([], { id: "cached-model", provider: "openai", api: "openai-responses" });
	const wire = paidBoundary({});
	await h.emit("session_start", c);
	await realRequest(h, c, { model: "cached-model", input: [{ role: "user", content: "Actual input" }], conversation },
		assistant(usage(12, 500), { model: "cached-model", provider: "openai", api: "openai-responses", timestamp: NOW }));
	clock.mockReturnValue(NOW + 240_000);
	c.tick();
	await settle();
	await h.command(c, "warm now");
	expect(wire.sends).toHaveLength(0);
	expect(c.notifications.at(-1)).toContain("linked server conversations");
	expect(c.history).toHaveLength(1);
	await h.emit("session_shutdown", c);
});

test.each([true, false])("final transformed Anthropic thinking determines bounded-cap eligibility: budget=%s", async budget => {
	const h = harness();
	const c = context([], { id: "claude-fable", provider: "anthropic", api: "anthropic-messages" });
	const wire = paidBoundary({});
	const body = { model: "claude-fable", messages: [{ role: "user", content: "Actual prefix" }],
		max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 4096 } as Record<string, unknown> };
	await h.emit("session_start", c);
	await h.emit("before_agent_start", c);
	await h.emit("before_provider_request", c, { payload: body });
	body.thinking = budget ? { type: "enabled", budget_tokens: 4096 } : { type: "adaptive" };
	const message = assistant(usage(12, 500), { model: "claude-fable", provider: "anthropic", api: "anthropic-messages", timestamp: NOW });
	await h.emit("assistant_message", c, { message });
	c.history.push(message);
	await h.emit("message_end", c, { message });
	await h.emit("agent_end", c);
	const completion = h.command(c, "warm now");
	await settle();
	if (budget) {
		expect(wire.sends).toHaveLength(0);
		expect(c.status).toContain("warm unavailable");
		expect(c.notifications.at(-1)).toContain("budget-based thinking");
	} else {
		expect(wire.sends).toHaveLength(1);
		expect(wire.sends[0]).toMatchObject({ max_tokens: 1, thinking: { type: "adaptive" } });
		wire.finish(warmReply({ model: "claude-fable", provider: "anthropic", api: "anthropic-messages", stopReason: "length" }));
	}
	await completion;
	await h.emit("session_shutdown", c);
});

test("observed Google image output without a declared modality is not repeated invisibly", async () => {
	const h = harness();
	const c = context([], { id: "cached-image-model", provider: "google", api: "google-generative-ai" });
	const wire = paidBoundary({});
	await h.emit("session_start", c);
	await realRequest(h, c, { model: "cached-image-model", contents: [{ role: "user", parts: [{ text: "Actual input" }] }],
		config: { maxOutputTokens: 8192 } }, assistant(usage(12, 500), { model: "cached-image-model", provider: "google",
		api: "google-generative-ai", timestamp: NOW, content: [{ type: "image", data: "native-image-data", mimeType: "image/png" }] }));
	clock.mockReturnValue(NOW + 240_000);
	c.tick();
	await settle();
	await h.command(c, "warm now");
	expect(wire.sends).toHaveLength(0);
	expect(c.notifications.at(-1)).toContain("observed non-text generation");
	await h.emit("session_shutdown", c);
});

test.each(["before_agent_start", "session_shutdown", "timeout", "off"] as const)(
	"%s propagates cancellation into native auth before any provider dispatch",
	async action => {
		const h = harness();
		const c = context();
		const wire = paidBoundary();
		let authSignal: AbortSignal | undefined;
		let release!: (key: string) => void;
		c.setAuth(signal => {
			authSignal = signal;
			return new Promise<string>(resolve => { release = resolve; });
		});
		await h.emit("session_start", c);
		await realRequest(h, c);
		const completion = h.command(c, "warm now");
		await settle();
		expect(authSignal?.aborted).toBe(false);
		if (action === "timeout") c.expireRequest();
		else if (action === "off") await h.command(c, "off");
		else await h.emit(action, c);
		await completion;
		expect(authSignal?.aborted).toBe(true);
		expect(c.timeouts.size).toBe(0);
		release("late-private-credential");
		await settle();
		expect(wire.sends).toHaveLength(0);
		expect(provider).not.toHaveBeenCalled();
		expect(c.notifications.join(" ")).not.toContain("late-private-credential");
		await h.emit("session_shutdown", c);
	},
);

test.each(["gpt-6.1-sol", "gpt-6", "gpt-5.3-codex"])(
	"Codex %s finishes a tiny hidden reply before claiming reported cache reuse",
	async id => {
		const h = harness();
		const c = context([], { id, provider: "openai-codex", api: "openai-codex-responses" });
		const wire = paidBoundary();
		const body = payload({ model: id, tools: [], tool_choice: undefined });
		await h.emit("session_start", c);
		await realRequest(h, c, body, assistant(usage(128, 1_920), { model: id, timestamp: NOW }));
		expect(c.status).toContain("warm pending");
		const completion = h.command(c, "warm now");
		await settle();
		const suffix = [
			...(/^gpt-6(?:[.-]|$)/i.test(id) ? [{ type: "configuration_update", reasoning: { effort: "low" } }] : []),
			{ role: "user", content: [{ type: "input_text", text: "Reply with only: ok" }] },
		];
		expect(wire.sends[0].input).toEqual([...(body.input as unknown[]), ...suffix]);
		expect(wire.sends[0].tool_choice).toBeUndefined();
		const reply = warmReply({ model: id, content: [{ type: "text", text: "ok" }],
			usage: { ...warmReply().usage, output: 5, totalTokens: 2_053 } });
		wire.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: reply });
		await settle();
		expect(wire.signals[0].aborted).toBe(false);
		expect(c.status).toContain("warming");
		wire.finish(reply);
		await completion;
		expect(c.status).not.toMatch(/warm pending|warming|warm miss|warm off/);
		expect(c.history).toHaveLength(1);
		expect(c.notifications.join(" ")).not.toContain("Reply with only");
		await realRequest(h, c, body, assistant(usage(128, 1_920), { model: id, timestamp: NOW }));
		expect(c.status).toContain("warm pending");
		await h.emit("session_shutdown", c);
	},
);

test.each(["openai-codex-responses", "openai-responses", "anthropic-messages", "ollama-chat"] as const)(
	"%s reports zero-read writes as a warm miss and retries only at normal cadence",
	async api => {
		const codex = api === "openai-codex-responses";
		const providerName = codex ? "openai-codex" : api === "anthropic-messages" ? "anthropic"
			: api === "ollama-chat" ? "ollama" : "openai";
		const id = codex ? "gpt-6.1-sol" : "cached-model";
		const h = harness();
		const c = context([], { id, provider: providerName, api });
		const wire = paidBoundary(codex ? { type: "response.create" } : {});
		const body = codex || api === "openai-responses"
			? payload({ model: id }) : { model: id, messages: [{ role: "user", content: "Actual prefix" }] };
		await h.emit("session_start", c);
		await realRequest(h, c, body, assistant(usage(128, 1_920), { model: id, provider: providerName, api, timestamp: NOW }));
		const completion = h.command(c, "warm now");
		await settle();
		const reply = warmReply({ model: id, provider: providerName, api,
			usage: { ...warmReply().usage, input: 1_920, cacheRead: 0, cacheWrite: 128, totalTokens: 2_048 } });
		wire.finish(reply);
		await completion;
		expect(c.status).toContain("warm miss");
		expect(c.status).toContain("ttl ?");
		expect(c.status).not.toMatch(/~\d|warm off/);
		await h.command(c, "warm");
		expect(c.notifications.at(-1)).toMatch(/miss; next in.*1 calls.*\$0\.000448.*no cache reuse/);
		const delay = codex ? 1_500_000 : 240_000;
		clock.mockReturnValue(NOW + delay - 1);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(1);
		clock.mockReturnValue(NOW + delay);
		c.tick();
		await settle();
		expect(wire.sends).toHaveLength(2);
		wire.finish(warmReply({ model: id, provider: providerName, api }));
		await settle();
		expect(c.status).not.toContain("warm miss");
		expect(c.status).not.toContain("warm off");
		await h.emit("session_shutdown", c);
	},
);

test.each([200, 400, 401, 413, 429, 500])(
	"HTTP %s warm transport guard is request-local and never reads rejected prompt diagnostics",
	async status => {
		const h = harness();
		const c = context([], { id: "cached-model", provider: "openai", api: "openai-responses" });
		const wire = paidBoundary({});
		await h.emit("session_start", c);
		await realRequest(h, c, payload({ model: "cached-model" }), assistant(usage(128, 1_920), {
			model: "cached-model", provider: "openai", api: "openai-responses", timestamp: NOW,
		}));
		const completion = h.command(c, "warm now");
		await settle();
		const response = new Response("Private provider diagnostic body", { status });
		const readText = spyOn(response, "text");
		const readJson = spyOn(response, "json");
		cacheHttp.mockResolvedValue(response);
		const input = "https://native-test.invalid/responses";
		const init = { method: "POST", body: "Private captured prefix", signal: wire.signals[0] };
		const transport = wire.options[0].fetch!;
		if (status === 400 || status === 413) {
			let rejected: unknown;
			try { await transport(input, init); } catch (error) { rejected = error; }
			expect(rejected).toBeInstanceOf(Error);
			expect("status" in (rejected as Error)).toBe(false);
			expect(wire.signals[0].aborted).toBe(true);
			await completion;
			expect(c.status).toContain("warm off");
		} else {
			await transport(input, init);
			expect(wire.signals[0].aborted).toBe(false);
			wire.finish(warmReply({ model: "cached-model", provider: "openai", api: "openai-responses" }));
			await completion;
		}
		expect(readText).not.toHaveBeenCalled();
		expect(readJson).not.toHaveBeenCalled();
		expect(c.notifications.join(" ")).not.toMatch(/Private provider|Private captured/);
		await h.emit("session_shutdown", c);
	},
);

test.each([{ type: "error", status: 400 }, { type: "response.failed", status: 413 }] as const)(
	"native WS $type/$status rejects hidden warming before rejected-request persistence",
	async ({ type, status }) => {
		const privateText = "private-native-ws-regression-prefix";
		const root = await mkdtemp(join(tmpdir(), "cache-native-ws-"));
		const debug = Bun.env.PI_REQ_DEBUG;
		delete Bun.env.PI_REQ_DEBUG;
		// Exercise the real native writer despite its normal Bun-test opt-out,
		// confining actual disk writes to this test's disposable directory.
		const testRuntime = spyOn(nativeUtils, "isBunTestRuntime").mockReturnValue(false);
		const logs = spyOn(nativeUtils, "getLogsDir").mockReturnValue(root);
		const received: Record<string, unknown>[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("Only WebSocket requests are accepted", { status: 400 });
			},
			websocket: {
				message(socket, bytes) {
					const body = JSON.parse(String(bytes)) as Record<string, unknown>;
					if (body.type !== "response.create") return;
					received.push(body);
					const error = { code: "invalid_request_error", message: `HTTP ${status}: rejected ${privateText}` };
					socket.send(JSON.stringify(type === "error" ? { type, error }
						: { type, response: { id: "native_rejected", status: String(status), error } }));
				},
			},
		});
		const model = buildModel({
			id: "gpt-6.1-sol", name: "Native WS privacy regression", provider: "openai-codex",
			api: "openai-codex-responses", baseUrl: `http://127.0.0.1:${server.port}`,
			reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		});
		const body = payload({ instructions: privateText, input: [{ role: "user", content: privateText }] });
		const baselineStates = new Map<string, ai.ProviderSessionState>();
		const h = harness();
		const c = context([], model);
		try {
			// Positive control: the same real native WS failure writes the rejected
			// frame without our hooks. This proves the diagnostic sink is active.
			const baseline = await streamOpenAICodexResponses(model, { messages: [] }, {
				apiKey: "test-credential", sessionId: "native-ws-baseline", providerSessionState: baselineStates,
				preferWebsockets: true, statefulResponses: false, codexSseMaxAttempts: 1,
				onPayload: () => ({ ...structuredClone(body), type: "response.create" }),
			}).result();
			expect(baseline.stopReason).toBe("error");
			expect(baseline.errorStatus).toBe(status);
			const dumpDir = join(root, "http-400-requests");
			const before = await readdir(dumpDir);
			expect(before).toHaveLength(1);
			expect(await readFile(join(dumpDir, before[0]), "utf8")).toContain(privateText);
			for (const state of baselineStates.values()) state.close();
			baselineStates.clear();

			const nativeReplies: Promise<AssistantMessage>[] = [];
			provider.mockImplementation((model, context, options) => {
				// Forward the extension's actual hooks through the real native
				// socket parser, queue, recovery ladder, finalizer and logger.
				if (!isCodexModel(model) || options === undefined) {
					throw new Error("Expected the native Codex model and refresh options");
				}
				const stream = streamOpenAICodexResponses(model, context, options);
				nativeReplies.push(stream.result());
				return stream;
			});
			await h.emit("session_start", c);
			await realRequest(h, c, body);
			await h.command(c, "warm now");
			const replies = await Promise.all(nativeReplies);
			expect(replies).toHaveLength(1);
			expect(["error", "aborted"]).toContain(replies[0].stopReason);
			expect(replies[0].errorMessage).not.toContain(privateText);
			expect(replies[0].errorMessage).not.toContain("raw-http-request=");
			expect(received).toHaveLength(2); // Baseline + exactly one hidden send; no retry.
			expect(received[1].input).toEqual(codexWarmInput(body.input as unknown[]));
			expect(received[1].instructions).toBe(privateText); // Redaction never changed wire bytes.
			expect(body.instructions).toBe(privateText);
			expect(await readdir(dumpDir)).toEqual(before);
			expect(c.status).toContain("warm off");
			expect(c.notifications.at(-1)).toContain("The provider rejected the refresh; prompt diagnostics were suppressed.");
			expect(c.notifications.join(" ")).not.toContain(privateText);
			expect(c.history).toHaveLength(1);
		} finally {
			await h.emit("session_shutdown", c);
			for (const state of baselineStates.values()) state.close();
			server.stop(true);
			testRuntime.mockRestore();
			logs.mockRestore();
			if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = debug;
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);

test("native request-body debugging prevents hidden prompt persistence without changing foreground diagnostics", async () => {
	const debug = Bun.env.PI_REQ_DEBUG;
	const h = harness();
	const c = context();
	const wire = paidBoundary();
	try {
		Bun.env.PI_REQ_DEBUG = "1";
		await h.emit("session_start", c);
		await realRequest(h, c);
		await h.command(c, "warm now");
		expect(provider).not.toHaveBeenCalled();
		expect(wire.sends).toHaveLength(0);
		expect(c.status).toContain("warm off");
		expect(c.notifications.at(-1)).toContain("Native request-body debugging is enabled");
		expect(Bun.env.PI_REQ_DEBUG).toBe("1");
		expect(c.history).toHaveLength(1);
	} finally {
		await h.emit("session_shutdown", c);
		if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
		else Bun.env.PI_REQ_DEBUG = debug;
	}
});

test.each([
	{ api: "google-generative-ai", providerName: "google", status: 400 },
	{ api: "google-generative-ai", providerName: "google", status: 413 },
	{ api: "google-vertex", providerName: "google-vertex", status: 400 },
	{ api: "google-vertex", providerName: "google-vertex", status: 413 },
] as const)(
	"public SDK release: $api HTTP 200 in-band $status never persists the hidden prefix",
	async ({ api, providerName, status }) => {
		const privateText = "private-public-sdk-google-prefix";
		const root = await mkdtemp(join(tmpdir(), "cache-native-google-"));
		const debug = Bun.env.PI_REQ_DEBUG;
		delete Bun.env.PI_REQ_DEBUG;
		const testRuntime = spyOn(nativeUtils, "isBunTestRuntime").mockReturnValue(false);
		const logs = spyOn(nativeUtils, "getLogsDir").mockReturnValue(root);
		const received: Record<string, unknown>[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				if (request.method !== "POST" || !new URL(request.url).pathname.endsWith(":streamGenerateContent")) {
					throw new Error("Unexpected native Google request");
				}
				received.push(await request.json() as Record<string, unknown>);
				return new Response(`data: ${JSON.stringify({ error: { code: status, message: `rejected ${privateText}` } })}\n\n`, {
					status: 200, headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const localBase = `http://127.0.0.1:${server.port}`;
		const endpoint = api === "google-generative-ai"
			? `${localBase}/models/gemini-cached:streamGenerateContent?alt=sse`
			: "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-cached:streamGenerateContent?alt=sse";
		// Vertex ignores model.baseUrl. Accept only its exact dummy-model URL,
		// then use real native HTTP/SSE exclusively against the loopback server.
		cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
			if (String(input) !== endpoint) throw new Error("Unexpected native Google endpoint");
			const path = new URL(endpoint);
			return nativeFetch(`${localBase}${path.pathname}${path.search}`, init);
		}));
		const model = buildModel({
			id: "gemini-cached", name: "Native Google privacy regression", provider: providerName,
			api, baseUrl: localBase, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		});
		const nativeSDK = (requestModel: ai.Model, requestContext: ai.Context, options: StreamOptions) => {
			if (isNativeApi(requestModel, "google-generative-ai")) return streamGoogle(requestModel, requestContext, options);
			if (isNativeApi(requestModel, "google-vertex")) {
				return streamGoogleVertex(requestModel, requestContext, { ...options, location: "global" });
			}
			throw new Error("Expected a native Google model");
		};
		const body = {
			model: model.id, contents: [{ role: "user", parts: [{ text: privateText }] }],
			config: { systemInstruction: { parts: [{ text: privateText }] }, maxOutputTokens: 8192 },
		};
		const h = harness();
		const c = context([], model);
		c.setAuth(async () => "dummy-public-sdk-api-key");
		try {
			// Foreground positive control: the published finalizer really writes
			// this HTTP-200/status-bearing failure without the warmer's hooks.
			const baseline = await nativeSDK(model, { messages: [] }, {
				apiKey: "dummy-public-sdk-api-key", fetch: cacheHttp,
				onPayload: () => structuredClone(body),
			}).result();
			expect(baseline.stopReason).toBe("error");
			expect(baseline.errorStatus).toBe(status);
			const dumpDir = join(root, "http-400-requests");
			const before = await readdir(dumpDir);
			expect(before).toHaveLength(1);
			const foregroundDump = await readFile(join(dumpDir, before[0]), "utf8");
			expect(foregroundDump.includes(privateText)).toBe(true);

			const replies: Promise<AssistantMessage>[] = [];
			provider.mockImplementation((requestModel, requestContext, options) => {
				if (requestModel.api !== api || !options?.fetch) throw new Error("Expected native Google refresh options");
				const stream = nativeSDK(requestModel, requestContext, options);
				replies.push(stream.result());
				return stream;
			});
			await h.emit("session_start", c);
			await realRequest(h, c, body, assistant(usage(12, 500), {
				model: model.id, provider: providerName, api, timestamp: NOW,
			}));
			await h.command(c, "warm now");
			const completed = await Promise.all(replies);
			expect(completed).toHaveLength(1);
			expect(["error", "aborted"]).toContain(completed[0].stopReason);
			expect(received).toHaveLength(2); // Foreground control + one actual hidden HTTP send.
			expect(JSON.stringify(received[1].contents) === JSON.stringify(body.contents)).toBe(true);
			expect(JSON.stringify(received[1].systemInstruction) === JSON.stringify(body.config.systemInstruction)).toBe(true);
			expect((received[1].generationConfig as Record<string, unknown>).maxOutputTokens).toBe(1);
			const after = await readdir(dumpDir);
			for (const file of after.filter(file => !before.includes(file))) {
				expect((await readFile(join(dumpDir, file), "utf8")).includes(privateText)).toBe(false);
			}
			expect(await readFile(join(dumpDir, before[0]), "utf8") === foregroundDump).toBe(true);
			expect(completed[0].errorMessage?.includes(privateText) ?? false).toBe(false);
			expect(c.notifications.join(" ").includes(privateText)).toBe(false);
			expect(c.status).toContain("warm off");
			expect(c.history).toHaveLength(1);
		} finally {
			await h.emit("session_shutdown", c);
			server.stop(true);
			testRuntime.mockRestore();
			logs.mockRestore();
			if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = debug;
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);

test("public SDK release: native OpenAI HTTP 500 retry cannot resend a hidden inference", async () => {
	type InferencePhase = "foreground-control" | "warm";
	let phase: InferencePhase = "foreground-control";
	const received: { phase: InferencePhase; body: Record<string, unknown> }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			if (request.method !== "POST" || new URL(request.url).pathname !== "/chat/completions") {
				throw new Error("Unexpected native OpenAI request");
			}
			received.push({ phase, body: await request.json() as Record<string, unknown> });
			if (received.filter(send => send.phase === phase).length === 1) {
				return Response.json({ error: { message: "transient local regression failure", type: "server_error" } }, {
					status: 500, headers: { "retry-after-ms": "0" },
				});
			}
			const chunk = {
				id: "chatcmpl-local-regression", object: "chat.completion.chunk", created: 1, model: "cached-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 2048, completion_tokens: 1, total_tokens: 2049,
					prompt_tokens_details: { cached_tokens: 1024 } },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	const baseUrl = `http://127.0.0.1:${server.port}`;
	cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
		if (String(input) !== `${baseUrl}/chat/completions`) throw new Error("Unexpected native OpenAI endpoint");
		return nativeFetch(input, init);
	}));
	const model = buildModel({
		id: "cached-model", name: "Native OpenAI retry regression", provider: "openai", api: "openai-completions",
		baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	});
	const body = { model: model.id, stream: true, messages: [{ role: "user", content: "Actual cacheable local prefix" }],
		max_tokens: 8192 };
	const h = harness();
	const c = context([], model);
	c.setAuth(async () => "dummy-public-sdk-api-key");
	try {
		const baseline = await streamOpenAICompletions(model, { messages: [] }, {
			apiKey: "dummy-public-sdk-api-key", fetch: cacheHttp, onPayload: () => structuredClone(body),
		}).result();
		expect(baseline.stopReason).toBe("stop");
		expect(received.filter(send => send.phase === "foreground-control")).toHaveLength(2);
		phase = "warm";
		const replies: Promise<AssistantMessage>[] = [];
		provider.mockImplementation((requestModel, requestContext, options) => {
			if (!isNativeApi(requestModel, "openai-completions") || !options?.fetch) throw new Error("Expected native OpenAI refresh options");
			const stream = streamOpenAICompletions(requestModel, requestContext, options);
			replies.push(stream.result());
			return stream;
		});
		await h.emit("session_start", c);
		await realRequest(h, c, body, assistant(usage(12, 500), {
			model: model.id, provider: "openai", api: "openai-completions", timestamp: NOW,
		}));
		await h.command(c, "warm now");
		const warmSends = received.filter(send => send.phase === "warm");
		expect(warmSends).toHaveLength(1); // Count server receipts, not payload-hook calls.
		expect(warmSends[0].body.messages).toEqual(body.messages);
		expect(warmSends[0].body.max_tokens).toBe(1);
		expect(body.max_tokens).toBe(8192);
		const completed = await Promise.all(replies);
		expect(completed).toHaveLength(1);
		expect(["error", "aborted"]).toContain(completed[0].stopReason);
		expect(c.status).toContain("warm off");
		expect(c.notifications.at(-1)).toContain("automatic warm retries are disabled");
		expect(c.history).toHaveLength(1);
	} finally {
		await h.emit("session_shutdown", c);
		server.stop(true);
	}
}, 15_000);

test.each([
	{ api: "google-generative-ai", providerName: "google", mutation: "change" },
	{ api: "google-generative-ai", providerName: "google", mutation: "add" },
	{ api: "google-generative-ai", providerName: "google", mutation: "remove" },
	{ api: "google-generative-ai", providerName: "google", mutation: "invalid" },
	{ api: "google-vertex", providerName: "google-vertex", mutation: "change" },
	{ api: "google-vertex", providerName: "google-vertex", mutation: "add" },
	{ api: "google-vertex", providerName: "google-vertex", mutation: "remove" },
	{ api: "google-vertex", providerName: "google-vertex", mutation: "invalid" },
] as const)(
	"public SDK release: final $api in-place cachedContent $mutation selects only the settled resource",
	async ({ api, providerName, mutation }) => {
		const h = harness();
		const c = context([], { id: "gemini-cached", provider: providerName, api });
		const wire = paidBoundary({});
		const base = api === "google-generative-ai"
			? "https://generativelanguage.googleapis.com/v1beta"
			: "https://us-central1-aiplatform.googleapis.com/v1";
		const resourcePrefix = api === "google-generative-ai"
			? "cachedContents/" : "projects/dummy-project/locations/us-central1/cachedContents/";
		const oldName = `${resourcePrefix}old-cache`;
		const finalName = `${resourcePrefix}settled-cache`;
		const requests: { url: string; method: string; body?: RequestInit["body"] }[] = [];
		cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (![`${base}/${oldName}`, `${base}/${oldName}?updateMask=ttl`,
				`${base}/${finalName}`, `${base}/${finalName}?updateMask=ttl`].includes(url)) {
				throw new Error("Unexpected explicit-cache resource request");
			}
			requests.push({ url, method, body: init?.body });
			const name = url.includes(finalName) ? finalName : oldName;
			return Response.json(method === "PATCH"
				? { name, expireTime: new Date(NOW + 1_800_000).toISOString() }
				: { name, model: "models/gemini-cached", createTime: new Date(NOW).toISOString(),
					expireTime: new Date(NOW + 600_000).toISOString() });
		}));
		const body = {
			model: "gemini-cached", contents: [{ role: "user", parts: [{ text: "Final foreground prefix" }] }],
			config: { maxOutputTokens: 8192, ...(mutation === "add" ? {} : { cachedContent: oldName }) } as Record<string, unknown>,
		};
		try {
			await h.emit("session_start", c);
			await h.emit("before_agent_start", c);
			await h.emit("before_provider_request", c, { payload: body });
			// Native hooks share this object: these edits change the actual final request.
			if (mutation === "remove") delete body.config.cachedContent;
			else body.config.cachedContent = mutation === "invalid"
				? (api === "google-generative-ai" ? "../../invalid-cache" : "cachedContents/wrong-provider-format")
				: finalName;
			const message = assistant(usage(12, 500), { model: "gemini-cached", provider: providerName, api, timestamp: NOW });
			await h.emit("assistant_message", c, { message });
			c.history.push(message);
			await h.emit("message_end", c, { message });
			await h.emit("agent_end", c);
			const completion = h.command(c, "warm now");
			await settle();
			if (wire.streams.length) wire.finish(warmReply({ model: "gemini-cached", provider: providerName, api }));
			await completion;
			expect(requests.some(request => request.url.includes(oldName))).toBe(false);
			if (mutation === "change" || mutation === "add") {
				expect(requests).toEqual([
					{ url: `${base}/${finalName}`, method: "GET", body: undefined },
					{ url: `${base}/${finalName}?updateMask=ttl`, method: "PATCH", body: '{"ttl":"600s"}' },
				]);
				expect(wire.sends).toHaveLength(0);
				expect(provider).not.toHaveBeenCalled();
			} else if (mutation === "remove") {
				expect(requests).toHaveLength(0);
				expect(wire.sends).toHaveLength(1);
				expect((wire.sends[0].config as Record<string, unknown>).cachedContent).toBeUndefined();
				expect(wire.sends[0].contents).toEqual(body.contents);
			} else {
				expect(requests).toHaveLength(0);
				expect(wire.sends).toHaveLength(0);
				expect(provider).not.toHaveBeenCalled();
				expect(c.status).toContain("warm unavailable");
				expect(c.notifications.at(-1)).toContain("resource identity");
			}
			expect(c.history).toHaveLength(1);
		} finally {
			await h.emit("session_shutdown", c);
		}
	},
);

test("public SDK release: native Google chunked UTF-8 multiline SSE preserves a verified cache-hit warm", async () => {
	const received: Record<string, unknown>[] = [];
	const frame = ': chunked native regression\r\n'
		+ 'data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"é"}]},"finishReason":"STOP"}],\r\n'
		+ 'data: "usageMetadata":{"promptTokenCount":2048,"cachedContentTokenCount":1024,"candidatesTokenCount":1,"totalTokenCount":2049}}\r\n\r\n';
	const bytes = new TextEncoder().encode(frame);
	// Split inside CRLF, inside a two-byte UTF-8 character, and inside the
	// final CRLF delimiter; native HTTP/SSE must retain all original framing.
	const ends = [bytes.indexOf(13) + 1, bytes.indexOf(0xc3) + 1, bytes.length - 1, bytes.length];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			if (request.method !== "POST" || new URL(request.url).pathname !== "/models/gemini-cached:streamGenerateContent") {
				throw new Error("Unexpected native Google success request");
			}
			received.push(await request.json() as Record<string, unknown>);
			let offset = 0;
			let index = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					const end = ends[index++];
					controller.enqueue(bytes.subarray(offset, end));
					offset = end;
					if (offset === bytes.length) controller.close();
				},
			});
			return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	const baseUrl = `http://127.0.0.1:${server.port}`;
	cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
		if (String(input) !== `${baseUrl}/models/gemini-cached:streamGenerateContent?alt=sse`) {
			throw new Error("Unexpected native Google success endpoint");
		}
		const response = await nativeFetch(input, init);
		if (!response.body) throw new Error("Expected a real native streaming response");
		// TCP may coalesce server writes. Fragment the actual received bytes
		// deterministically so both the guard and SDK see split UTF-8/CRLF.
		const fragmented = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				for (let offset = 0; offset < chunk.length; offset++) controller.enqueue(chunk.subarray(offset, offset + 1));
			},
		}));
		return new Response(fragmented, { status: response.status, headers: response.headers });
	}));
	const model = buildModel({
		id: "gemini-cached", name: "Native Google framing regression", provider: "google", api: "google-generative-ai",
		baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	});
	const h = harness();
	const c = context([], { ...model, promptCache: { short: 300 } });
	c.setAuth(async () => "dummy-public-sdk-api-key");
	const body = {
		model: model.id, contents: [{ role: "user", parts: [{ text: "Stable café prefix" }] }],
		config: { systemInstruction: { parts: [{ text: "Keep the exact instructions." }] }, maxOutputTokens: 8192 },
	};
	const foreground = assistant(usage(12, 500), {
		model: model.id, provider: "google", api: "google-generative-ai", timestamp: NOW,
	});
	const replies: Promise<AssistantMessage>[] = [];
	provider.mockImplementation((requestModel, requestContext, options) => {
		if (!isNativeApi(requestModel, "google-generative-ai") || !options?.fetch) {
			throw new Error("Expected native Google success refresh options");
		}
		const stream = streamGoogle(requestModel, requestContext, options);
		replies.push(stream.result());
		return stream;
	});
	try {
		await h.emit("session_start", c);
		await realRequest(h, c, body, foreground);
		const branch = structuredClone(c.ctx.sessionManager.getBranch());
		expect(c.status).toContain("warm pending");
		clock.mockReturnValue(NOW + 60_000);
		await h.command(c, "warm now");
		const completed = await Promise.all(replies);
		expect(completed).toHaveLength(1);
		expect(completed[0].stopReason).toBe("stop");
		expect(completed[0].content).toEqual([{ type: "text", text: "é" }]);
		expect(completed[0].usage.cacheRead).toBe(1024);
		expect(completed[0].usage.output).toBe(1);
		expect(received).toHaveLength(1);
		expect(received[0].contents).toEqual(body.contents);
		expect(received[0].systemInstruction).toEqual(body.config.systemInstruction);
		expect((received[0].generationConfig as Record<string, unknown>).maxOutputTokens).toBe(1);
		expect(body.config.maxOutputTokens).toBe(8192);
		expect(c.status).not.toMatch(/warm pending|warming|warm miss|warm off|warm unavailable/);
		expect(c.status).toMatch(/\b98%/);
		expect(c.ctx.sessionManager.getBranch()).toEqual(branch);
		expect(c.history).toEqual([foreground]);
		await h.command(c, "warm");
		expect(c.notifications.at(-1)).toMatch(/1 calls/);
		expect(c.notifications.at(-1)).not.toMatch(/unpriced|no cache reuse/);
	} finally {
		await h.emit("session_shutdown", c);
		server.stop(true);
	}
}, 15_000);

test.each([
	{ code: 400, status: 400, messageStatus: false },
	{ code: "413", status: 413, messageStatus: false },
	{ code: "invalid_request_error", status: 400, messageStatus: true },
] as const)(
	"public SDK closure: native Completions HTTP 200 error.code $code never persists the hidden prefix or echo",
	async ({ code, status, messageStatus }) => {
		const privateText = "private-public-sdk-completions-prefix";
		const echoedText = `${messageStatus ? `HTTP ${status}: ` : ""}rejected ${privateText} via native SSE error`;
		const root = await mkdtemp(join(tmpdir(), "cache-native-completions-"));
		const debug = Bun.env.PI_REQ_DEBUG;
		delete Bun.env.PI_REQ_DEBUG;
		const testRuntime = spyOn(nativeUtils, "isBunTestRuntime").mockReturnValue(false);
		const logs = spyOn(nativeUtils, "getLogsDir").mockReturnValue(root);
		type InferencePhase = "foreground-control" | "warm";
		let phase: InferencePhase = "foreground-control";
		const received: { phase: InferencePhase; body: Record<string, unknown> }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				if (request.method !== "POST" || new URL(request.url).pathname !== "/chat/completions") {
					throw new Error("Unexpected native Completions privacy request");
				}
				received.push({ phase, body: await request.json() as Record<string, unknown> });
				return new Response(`data: ${JSON.stringify({ error: { code, message: echoedText } })}\n\n`, {
					status: 200, headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const baseUrl = `http://127.0.0.1:${server.port}`;
		cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
			if (String(input) !== `${baseUrl}/chat/completions`) {
				throw new Error("Unexpected native Completions privacy endpoint");
			}
			return nativeFetch(input, init);
		}));
		const model = buildModel({
			id: "cached-model", name: "Native Completions privacy closure", provider: "openai", api: "openai-completions",
			baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		});
		const body = {
			model: model.id, stream: true, max_tokens: 8192,
			messages: [{ role: "system", content: privateText }, { role: "user", content: privateText }],
		};
		const h = harness();
		const c = context([], model);
		c.setAuth(async () => "dummy-public-sdk-api-key");
		try {
			// The unguarded published SDK must really persist both the request
			// canary and its provider echo in this disposable diagnostic sink.
			const baseline = await streamOpenAICompletions(model, { messages: [] }, {
				apiKey: "dummy-public-sdk-api-key", fetch: cacheHttp, onPayload: () => structuredClone(body),
			}).result();
			expect(baseline.stopReason).toBe("error");
			expect(baseline.errorStatus).toBe(status);
			expect(baseline.errorMessage).toContain(echoedText);
			const dumpDir = join(root, "http-400-requests");
			const before = await readdir(dumpDir);
			expect(before).toHaveLength(1);
			const foregroundDump = await readFile(join(dumpDir, before[0]), "utf8");
			const diagnostic = JSON.parse(foregroundDump) as { body: unknown; errorResponse: { message: string } };
			expect(JSON.stringify(diagnostic.body)).toContain(privateText);
			expect(diagnostic.errorResponse.message).toContain(echoedText);
			expect(received.filter(send => send.phase === "foreground-control")).toHaveLength(1);

			phase = "warm";
			const replies: Promise<AssistantMessage>[] = [];
			provider.mockImplementation((requestModel, requestContext, options) => {
				if (!isNativeApi(requestModel, "openai-completions") || !options?.fetch) {
					throw new Error("Expected native Completions privacy refresh options");
				}
				const stream = streamOpenAICompletions(requestModel, requestContext, options);
				replies.push(stream.result());
				return stream;
			});
			await h.emit("session_start", c);
			await realRequest(h, c, body, assistant(usage(12, 500), {
				model: model.id, provider: "openai", api: "openai-completions", timestamp: NOW,
			}));
			await h.command(c, "warm now");
			const completed = await Promise.all(replies);
			expect(completed).toHaveLength(1);
			expect(["error", "aborted"]).toContain(completed[0].stopReason);
			const warmSends = received.filter(send => send.phase === "warm");
			expect(warmSends).toHaveLength(1);
			expect(warmSends[0].body.messages).toEqual(body.messages);
			expect(warmSends[0].body.max_tokens).toBe(1);
			expect(body.max_tokens).toBe(8192);
			const after = await readdir(dumpDir);
			for (const file of after.filter(file => !before.includes(file))) {
				const dump = await readFile(join(dumpDir, file), "utf8");
				expect(dump.includes(privateText)).toBe(false);
				expect(dump.includes(echoedText)).toBe(false);
			}
			expect(await readFile(join(dumpDir, before[0]), "utf8")).toBe(foregroundDump);
			expect(completed[0].errorMessage?.includes(privateText) ?? false).toBe(false);
			expect(c.notifications.join(" ").includes(privateText)).toBe(false);
			expect(c.status).toContain("warm off");
			expect(c.history).toHaveLength(1);
		} finally {
			await h.emit("session_shutdown", c);
			server.stop(true);
			testRuntime.mockRestore();
			logs.mockRestore();
			if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = debug;
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);

test.each([
	{ api: "google-generative-ai", providerName: "google", modelId: "gemini-cached" },
	{ api: "openai-completions", providerName: "openai", modelId: "cached-model" },
] as const)(
	"public SDK closure: native $api DONE cleanup cancels the open HTTP stream without stopping a verified warm",
	async ({ api, providerName, modelId }) => {
		type InferencePhase = "foreground-control" | "warm";
		let phase: InferencePhase = "foreground-control";
		const received: { phase: InferencePhase; body: Record<string, unknown> }[] = [];
		const cancellations: InferencePhase[] = [];
		const baselineCancelled = Promise.withResolvers<void>();
		const warmCancelled = Promise.withResolvers<void>();
		const google = api === "google-generative-ai";
		const path = google ? `/models/${modelId}:streamGenerateContent` : "/chat/completions";
		const frame = google ? {
			candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 2048, cachedContentTokenCount: 1024, candidatesTokenCount: 1, totalTokenCount: 2049 },
		} : {
			id: "chatcmpl-local-closure", object: "chat.completion.chunk", created: 1, model: modelId,
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 2048, completion_tokens: 1, total_tokens: 2049,
				prompt_tokens_details: { cached_tokens: 1024 } },
		};
		const bytes = new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				if (request.method !== "POST" || new URL(request.url).pathname !== path) {
					throw new Error("Unexpected native sentinel cleanup request");
				}
				const requestPhase = phase;
				received.push({ phase: requestPhase, body: await request.json() as Record<string, unknown> });
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes);
						// No EOF: successful native [DONE] handling must cancel this source.
					},
					cancel() {
						cancellations.push(requestPhase);
						(requestPhase === "foreground-control" ? baselineCancelled : warmCancelled).resolve();
					},
				});
				return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		const baseUrl = `http://127.0.0.1:${server.port}`;
		const endpoint = `${baseUrl}${path}${google ? "?alt=sse" : ""}`;
		cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
			if (String(input) !== endpoint) throw new Error("Unexpected native sentinel cleanup endpoint");
			return nativeFetch(input, init);
		}));
		const model = buildModel({
			id: modelId, name: "Native sentinel cleanup closure", provider: providerName, api,
			baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		});
		const nativeSDK = (requestModel: ai.Model, requestContext: ai.Context, options: StreamOptions) => {
			if (isNativeApi(requestModel, "google-generative-ai")) return streamGoogle(requestModel, requestContext, options);
			if (isNativeApi(requestModel, "openai-completions")) return streamOpenAICompletions(requestModel, requestContext, options);
			throw new Error("Expected a native sentinel cleanup model");
		};
		const googleBody = {
			model: model.id, contents: [{ role: "user", parts: [{ text: "Stable café prefix" }] }],
			config: { systemInstruction: { parts: [{ text: "Keep the exact instructions." }] }, maxOutputTokens: 8192 },
		};
		const completionsBody = {
			model: model.id, stream: true, max_tokens: 8192,
			messages: [{ role: "system", content: "Keep the exact instructions." }, { role: "user", content: "Stable café prefix" }],
		};
		const body = google ? googleBody : completionsBody;
		const h = harness();
		const c = context([], { ...model, promptCache: { short: 300 } });
		c.setAuth(async () => "dummy-public-sdk-api-key");
		const foreground = assistant(usage(12, 500), { model: model.id, provider: providerName, api, timestamp: NOW });
		const debug = Bun.env.PI_REQ_DEBUG;
		delete Bun.env.PI_REQ_DEBUG;
		try {
			const baseline = await nativeSDK(model, { messages: [] }, {
				apiKey: "dummy-public-sdk-api-key", fetch: cacheHttp, onPayload: () => structuredClone(body),
			}).result();
			// Await source cancellation, not a guessed delay. The test deadline
			// bounds a missing cleanup signal; the server never supplies EOF.
			await baselineCancelled.promise;
			expect(baseline.stopReason).toBe("stop");
			expect(baseline.content).toEqual([{ type: "text", text: "ok" }]);
			expect(baseline.usage.cacheRead).toBe(1024);
			expect(cancellations).toEqual(["foreground-control"]);

			phase = "warm";
			const replies: Promise<AssistantMessage>[] = [];
			provider.mockImplementation((requestModel, requestContext, options) => {
				if (requestModel.api !== api || !options?.fetch) throw new Error("Expected native sentinel cleanup refresh options");
				const stream = nativeSDK(requestModel, requestContext, options);
				replies.push(stream.result());
				return stream;
			});
			await h.emit("session_start", c);
			await realRequest(h, c, body, foreground);
			const branch = structuredClone(c.ctx.sessionManager.getBranch());
			await h.command(c, "warm now");
			const completed = await Promise.all(replies);
			await warmCancelled.promise;
			expect(c.status).not.toMatch(/warm pending|warming|warm miss|warm off|warm unavailable/);
			expect(completed).toHaveLength(1);
			expect(completed[0].stopReason).toBe("stop");
			expect(completed[0].content).toEqual([{ type: "text", text: "ok" }]);
			expect(completed[0].usage.cacheRead).toBe(1024);
			expect(completed[0].usage.output).toBe(1);
			expect(cancellations).toEqual(["foreground-control", "warm"]);
			const warmSends = received.filter(send => send.phase === "warm");
			expect(warmSends).toHaveLength(1);
			if (google) {
				expect(warmSends[0].body.contents).toEqual(googleBody.contents);
				expect(warmSends[0].body.systemInstruction).toEqual(googleBody.config.systemInstruction);
				expect((warmSends[0].body.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(1);
				expect(googleBody.config.maxOutputTokens).toBe(8192);
			} else {
				expect(warmSends[0].body.messages).toEqual(completionsBody.messages);
				expect(warmSends[0].body.max_tokens).toBe(1);
				expect(completionsBody.max_tokens).toBe(8192);
			}
			expect(c.status).toMatch(/\b98%/);
			expect(c.ctx.sessionManager.getBranch()).toEqual(branch);
			expect(c.history).toEqual([foreground]);
			await h.command(c, "warm");
			expect(c.notifications.at(-1)).toMatch(/1 calls/);
			expect(c.notifications.at(-1)).not.toMatch(/unpriced|no cache reuse/);
		} finally {
			await h.emit("session_shutdown", c);
			server.stop(true);
			if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = debug;
		}
	},
	15_000,
);

test.each([
	{ api: "anthropic-messages", providerName: "anthropic", status: 400, failure: "error-event message fallback" },
	{ api: "openai-responses", providerName: "openai", status: 413, failure: "completed-but-failed status_details" },
] as const)(
	"public SDK closure: native $api $failure never persists the hidden prefix or echo",
	async ({ api, providerName, status }) => {
		const privateText = `private-public-sdk-${api}-prefix`;
		const echoedText = `HTTP ${status}: rejected ${privateText}`;
		const root = await mkdtemp(join(tmpdir(), "cache-native-protocol-"));
		const debug = Bun.env.PI_REQ_DEBUG;
		delete Bun.env.PI_REQ_DEBUG;
		const testRuntime = spyOn(nativeUtils, "isBunTestRuntime").mockReturnValue(false);
		const logs = spyOn(nativeUtils, "getLogsDir").mockReturnValue(root);
		type InferencePhase = "foreground-control" | "warm";
		let phase: InferencePhase = "foreground-control";
		const received: { phase: InferencePhase; body: Record<string, unknown> }[] = [];
		const anthropic = api === "anthropic-messages";
		const path = anthropic ? "/v1/messages" : "/responses";
		const event = anthropic ? "error" : "response.completed";
		const envelope = anthropic
			? { type: "error", error: { type: "invalid_request_error", message: echoedText } }
			: { type: "response.completed", response: {
				id: "resp_local_failed", status: "failed", output: [],
				status_details: { error: { code: "invalid_request_error", message: echoedText } },
			} };
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				if (request.method !== "POST" || new URL(request.url).pathname !== path) {
					throw new Error("Unexpected native protocol privacy request");
				}
				received.push({ phase, body: await request.json() as Record<string, unknown> });
				return new Response(`event: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`, {
					status: 200, headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		const baseUrl = `http://127.0.0.1:${server.port}`;
		cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
			if (String(input) !== `${baseUrl}${path}`) throw new Error("Unexpected native protocol privacy endpoint");
			return nativeFetch(input, init);
		}));
		const model = buildModel({
			id: "cached-model", name: "Native protocol privacy closure", provider: providerName, api,
			baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		});
		const nativeSDK = (requestModel: ai.Model, requestContext: ai.Context, options: StreamOptions) => {
			if (isNativeApi(requestModel, "anthropic-messages")) return streamAnthropic(requestModel, requestContext, options);
			if (isNativeApi(requestModel, "openai-responses")) return streamOpenAIResponses(requestModel, requestContext, options);
			throw new Error("Expected a native protocol privacy model");
		};
		const body: Record<string, unknown> = anthropic ? {
			model: model.id, stream: true, max_tokens: 8192,
			system: [{ type: "text", text: privateText }],
			messages: [{ role: "user", content: [{ type: "text", text: privateText }] }],
		} : {
			model: model.id, stream: true, max_output_tokens: 8192,
			instructions: privateText, input: [{ role: "user", content: privateText }],
		};
		const h = harness();
		const c = context([], model);
		c.setAuth(async () => "dummy-public-sdk-api-key");
		try {
			const baseline = await nativeSDK(model, { messages: [] }, {
				apiKey: "dummy-public-sdk-api-key", fetch: cacheHttp, onPayload: () => structuredClone(body),
			}).result();
			expect(baseline.stopReason).toBe("error");
			expect(baseline.errorStatus).toBe(status);
			expect(baseline.errorMessage).toContain(echoedText);
			const dumpDir = join(root, "http-400-requests");
			const before = await readdir(dumpDir);
			expect(before).toHaveLength(1);
			const foregroundDump = await readFile(join(dumpDir, before[0]), "utf8");
			const diagnostic = JSON.parse(foregroundDump) as { body: unknown; errorResponse: { message: string } };
			expect(JSON.stringify(diagnostic.body)).toContain(privateText);
			expect(diagnostic.errorResponse.message).toContain(echoedText);
			expect(received.filter(send => send.phase === "foreground-control")).toHaveLength(1);

			phase = "warm";
			const replies: Promise<AssistantMessage>[] = [];
			provider.mockImplementation((requestModel, requestContext, options) => {
				if (requestModel.api !== api || !options?.fetch) throw new Error("Expected native protocol privacy refresh options");
				const stream = nativeSDK(requestModel, requestContext, options);
				replies.push(stream.result());
				return stream;
			});
			await h.emit("session_start", c);
			await realRequest(h, c, body, assistant(usage(12, 500), {
				model: model.id, provider: providerName, api, timestamp: NOW,
			}));
			await h.command(c, "warm now");
			const completed = await Promise.all(replies);
			expect(completed).toHaveLength(1);
			expect(["error", "aborted"]).toContain(completed[0].stopReason);
			const warmSends = received.filter(send => send.phase === "warm");
			expect(warmSends).toHaveLength(1);
			const expected = { ...structuredClone(body), [anthropic ? "max_tokens" : "max_output_tokens"]: anthropic ? 1 : 16 };
			expect(warmSends[0].body).toEqual(expected);
			expect(body[anthropic ? "max_tokens" : "max_output_tokens"]).toBe(8192);
			for (const file of (await readdir(dumpDir)).filter(file => !before.includes(file))) {
				expect((await readFile(join(dumpDir, file), "utf8")).includes(privateText)).toBe(false);
			}
			expect(await readFile(join(dumpDir, before[0]), "utf8")).toBe(foregroundDump);
			expect(completed[0].errorMessage?.includes(privateText) ?? false).toBe(false);
			expect(c.notifications.join(" ").includes(privateText)).toBe(false);
			expect(c.status).toContain("warm off");
			expect(c.history).toHaveLength(1);
		} finally {
			await h.emit("session_shutdown", c);
			server.stop(true);
			testRuntime.mockRestore();
			logs.mockRestore();
			if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = debug;
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);

test.each(["unknown-exception", "cache-hit"] as const)(
	"public SDK closure: native Bedrock binary $mode preserves diagnostic isolation and cached consumption",
	async mode => {
		const privateText = "private-public-sdk-bedrock-prefix";
		const echoedText = `rejected ${privateText}`;
		const encoder = new TextEncoder();
		const decoder = new TextDecoder();
		const codec = new EventStreamCodec(bytes => decoder.decode(bytes), text => encoder.encode(text));
		const frame = (messageType: "event" | "exception", type: string, payload: Record<string, unknown>) => codec.encode({
			headers: {
				":message-type": { type: "string", value: messageType },
				[messageType === "event" ? ":event-type" : ":exception-type"]: { type: "string", value: type },
				":content-type": { type: "string", value: "application/json" },
			},
			body: encoder.encode(JSON.stringify(payload)),
		});
		const frames = mode === "unknown-exception"
			// No numeric code or HTTP text: native Bedrock maps unknown exceptions
			// to 400 itself, so JSON/status-only guards cannot protect this prefix.
			? [frame("exception", "UnrecognisedFixtureException", { message: echoedText })]
			: [
				frame("event", "messageStart", { role: "assistant" }),
				frame("event", "contentBlockDelta", { contentBlockIndex: 0, delta: { text: "é" } }),
				frame("event", "contentBlockStop", { contentBlockIndex: 0 }),
				frame("event", "messageStop", { stopReason: "end_turn" }),
				frame("event", "metadata", { usage: {
					inputTokens: 12, outputTokens: 1, cacheReadInputTokens: 500, cacheWriteInputTokens: 0, totalTokens: 513,
				} }),
			];
		const root = await mkdtemp(join(tmpdir(), "cache-native-bedrock-"));
		const debug = Bun.env.PI_REQ_DEBUG;
		delete Bun.env.PI_REQ_DEBUG;
		const testRuntime = spyOn(nativeUtils, "isBunTestRuntime").mockReturnValue(false);
		const logs = spyOn(nativeUtils, "getLogsDir").mockReturnValue(root);
		type InferencePhase = "foreground-control" | "warm";
		let phase: InferencePhase = "foreground-control";
		const received: { phase: InferencePhase; body: Record<string, unknown> }[] = [];
		const path = "/model/cached-model/converse-stream";
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				if (request.method !== "POST" || new URL(request.url).pathname !== path) {
					throw new Error("Unexpected native Bedrock binary request");
				}
				received.push({ phase, body: await request.json() as Record<string, unknown> });
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (const bytes of frames) controller.enqueue(bytes);
						controller.close();
					},
				});
				return new Response(stream, { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } });
			},
		});
		const baseUrl = `http://127.0.0.1:${server.port}`;
		cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
			if (String(input) !== `${baseUrl}${path}`) throw new Error("Unexpected native Bedrock binary endpoint");
			const response = await nativeFetch(input, init);
			if (!response.body) throw new Error("Expected a real native Bedrock binary response");
			// Split actual received bytes across prelude/header/UTF-8/CRC boundaries,
			// irrespective of TCP coalescing; native CRC validation remains active.
			const fragmented = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					for (let offset = 0; offset < chunk.length; offset++) controller.enqueue(chunk.subarray(offset, offset + 1));
				},
			}));
			return new Response(fragmented, { status: response.status, headers: response.headers });
		}));
		const model = buildModel({
			id: "cached-model", name: "Native Bedrock binary closure", provider: "amazon-bedrock", api: "bedrock-converse-stream",
			baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
			cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		});
		const body = {
			messages: [{ role: "user", content: [{ text: privateText }, { cachePoint: { type: "default" } }] }],
			system: [{ text: privateText }, { cachePoint: { type: "default" } }],
			inferenceConfig: { maxTokens: 8192, temperature: 0.2 },
		};
		const h = harness();
		const c = context([], model);
		// A dummy bearer key bypasses all AWS credentials/metadata discovery.
		c.setAuth(async () => "dummy-public-sdk-bedrock-bearer");
		const foreground = assistant(usage(12, 500), {
			model: model.id, provider: "amazon-bedrock", api: "bedrock-converse-stream", timestamp: NOW,
		});
		try {
			const baseline = await streamBedrock(model, { messages: [] }, {
				apiKey: "dummy-public-sdk-bedrock-bearer", fetch: cacheHttp, onPayload: () => structuredClone(body),
			}).result();
			const dumpDir = join(root, "http-400-requests");
			let before: string[] = [];
			let foregroundDump: string | undefined;
			if (mode === "unknown-exception") {
				expect(baseline.stopReason).toBe("error");
				expect(baseline.errorStatus).toBe(400);
				expect(baseline.errorMessage).toContain(echoedText);
				before = await readdir(dumpDir);
				expect(before).toHaveLength(1);
				foregroundDump = await readFile(join(dumpDir, before[0]), "utf8");
				const diagnostic = JSON.parse(foregroundDump) as { body: unknown; errorResponse: { message: string } };
				expect(JSON.stringify(diagnostic.body)).toContain(privateText);
				expect(diagnostic.errorResponse.message).toContain(echoedText);
			} else {
				expect(baseline.stopReason).toBe("stop");
				expect(baseline.content[0]).toMatchObject({ type: "text", text: "é" });
				expect(baseline.usage.cacheRead).toBe(500);
				expect(baseline.usage.output).toBe(1);
			}
			expect(received.filter(send => send.phase === "foreground-control")).toHaveLength(1);

			phase = "warm";
			const replies: Promise<AssistantMessage>[] = [];
			provider.mockImplementation((requestModel, requestContext, options) => {
				if (!isNativeApi(requestModel, "bedrock-converse-stream") || !options?.fetch) {
					throw new Error("Expected native Bedrock binary refresh options");
				}
				const stream = streamBedrock(requestModel, requestContext, options);
				replies.push(stream.result());
				return stream;
			});
			await h.emit("session_start", c);
			await realRequest(h, c, body, foreground);
			const branch = structuredClone(c.ctx.sessionManager.getBranch());
			await h.command(c, "warm now");
			const completed = await Promise.all(replies);
			expect(completed).toHaveLength(1);
			const warmSends = received.filter(send => send.phase === "warm");
			expect(warmSends).toHaveLength(1);
			expect(warmSends[0].body).toEqual({
				...structuredClone(body), inferenceConfig: { ...body.inferenceConfig, maxTokens: 1 },
			});
			expect(body.inferenceConfig.maxTokens).toBe(8192);
			if (mode === "unknown-exception") {
				expect(["error", "aborted"]).toContain(completed[0].stopReason);
				for (const file of (await readdir(dumpDir)).filter(file => !before.includes(file))) {
					expect((await readFile(join(dumpDir, file), "utf8")).includes(privateText)).toBe(false);
				}
				expect(await readFile(join(dumpDir, before[0]), "utf8")).toBe(foregroundDump!);
				expect(completed[0].errorMessage?.includes(privateText) ?? false).toBe(false);
				expect(c.notifications.join(" ").includes(privateText)).toBe(false);
				expect(c.status).toContain("warm off");
			} else {
				expect(c.status).not.toMatch(/warm pending|warming|warm miss|warm off|warm unavailable/);
				expect(completed[0].stopReason).toBe("stop");
				expect(completed[0].content[0]).toMatchObject({ type: "text", text: "é" });
				expect(completed[0].usage.cacheRead).toBe(500);
				expect(completed[0].usage.output).toBe(1);
				expect(c.status).toMatch(/\b98%/);
				await h.command(c, "warm");
				expect(c.notifications.at(-1)).toMatch(/1 calls/);
				expect(c.notifications.at(-1)).not.toMatch(/unpriced|no cache reuse/);
			}
			expect(c.ctx.sessionManager.getBranch()).toEqual(branch);
			expect(c.history).toEqual([foreground]);
		} finally {
			await h.emit("session_shutdown", c);
			server.stop(true);
			testRuntime.mockRestore();
			logs.mockRestore();
			if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
			else Bun.env.PI_REQ_DEBUG = debug;
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);

test("public SDK closure: native CLI ignores flat success and inspects an indexable nested private failed finish", async () => {
	const privateText = "private-public-sdk-cli-nested-prefix";
	const failedFinish = `HTTP 400: rejected ${privateText}`;
	const root = await mkdtemp(join(tmpdir(), "cache-native-cli-"));
	const debug = Bun.env.PI_REQ_DEBUG;
	delete Bun.env.PI_REQ_DEBUG;
	const testRuntime = spyOn(nativeUtils, "isBunTestRuntime").mockReturnValue(false);
	const logs = spyOn(nativeUtils, "getLogsDir").mockReturnValue(root);
	type InferencePhase = "foreground-control" | "warm";
	let phase: InferencePhase = "foreground-control";
	const received: { phase: InferencePhase; body: Record<string, unknown> }[] = [];
	const envelope = {
		// The real CLI decoder ignores this apparently successful flat payload.
		candidates: [{ finishReason: "STOP" }],
		response: {
			// Native candidates?.[0] also accepts an indexable JSON object, not
			// just arrays; inspecting only array candidates would miss this error.
			candidates: { "0": { index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: failedFinish } },
			usageMetadata: { promptTokenCount: 512, cachedContentTokenCount: 500, candidatesTokenCount: 1, totalTokenCount: 513 },
		},
	};
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			if (request.method !== "POST" || new URL(request.url).pathname !== "/v1internal:streamGenerateContent") {
				throw new Error("Unexpected native CLI nested-failure request");
			}
			received.push({ phase, body: await request.json() as Record<string, unknown> });
			return new Response(`data: ${JSON.stringify(envelope)}\n\n`, {
				status: 200, headers: { "Content-Type": "text/event-stream" },
			});
		},
	});
	const baseUrl = `http://127.0.0.1:${server.port}`;
	cacheHttp.mockImplementation(isolatedFetch(async (input, init) => {
		if (String(input) !== `${baseUrl}/v1internal:streamGenerateContent?alt=sse`) {
			throw new Error("Unexpected native CLI nested-failure endpoint");
		}
		return nativeFetch(input, init);
	}));
	const model = buildModel({
		id: "cached-model", name: "Native CLI nested privacy closure", provider: "google-gemini-cli", api: "google-gemini-cli",
		baseUrl, reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 8192,
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	});
	const credentials = JSON.stringify({ token: "dummy-public-sdk-cli-bearer", projectId: "fixture-project" });
	const body = {
		model: model.id, project: "fixture-project",
		request: {
			contents: [{ role: "user", parts: [{ text: privateText }] }],
			systemInstruction: { parts: [{ text: privateText }] },
			generationConfig: { maxOutputTokens: 8192 },
		},
	};
	const h = harness();
	const c = context([], model);
	c.setAuth(async () => credentials);
	try {
		const baseline = await streamGoogleGeminiCli(model, { messages: [] }, {
			apiKey: credentials, fetch: cacheHttp, onPayload: () => structuredClone(body),
		}).result();
		expect(baseline.stopReason).toBe("error");
		expect(baseline.errorStatus).toBe(400);
		expect(baseline.errorMessage).toContain(failedFinish);
		expect(baseline.content[0]).toMatchObject({ type: "text", text: "ok" });
		expect(baseline.usage.cacheRead).toBe(500);
		expect(baseline.usage.output).toBe(1);
		const dumpDir = join(root, "http-400-requests");
		const before = await readdir(dumpDir);
		expect(before).toHaveLength(1);
		const foregroundDump = await readFile(join(dumpDir, before[0]), "utf8");
		const diagnostic = JSON.parse(foregroundDump) as { body: unknown; errorResponse: { message: string } };
		expect(JSON.stringify(diagnostic.body)).toContain(privateText);
		expect(diagnostic.errorResponse.message).toContain(failedFinish);
		expect(received.filter(send => send.phase === "foreground-control")).toHaveLength(1);

		phase = "warm";
		const replies: Promise<AssistantMessage>[] = [];
		provider.mockImplementation((requestModel, requestContext, options) => {
			if (!isNativeApi(requestModel, "google-gemini-cli") || !options?.fetch) {
				throw new Error("Expected native CLI nested-failure refresh options");
			}
			const stream = streamGoogleGeminiCli(requestModel, requestContext, options);
			replies.push(stream.result());
			return stream;
		});
		await h.emit("session_start", c);
		await realRequest(h, c, body, assistant(usage(12, 500), {
			model: model.id, provider: "google-gemini-cli", api: "google-gemini-cli", timestamp: NOW,
		}));
		await h.command(c, "warm now");
		const completed = await Promise.all(replies);
		expect(completed).toHaveLength(1);
		expect(["error", "aborted"]).toContain(completed[0].stopReason);
		const warmSends = received.filter(send => send.phase === "warm");
		expect(warmSends).toHaveLength(1);
		expect(warmSends[0].body).toEqual({
			...structuredClone(body), request: { ...structuredClone(body.request), generationConfig: { maxOutputTokens: 1 } },
		});
		expect(body.request.generationConfig.maxOutputTokens).toBe(8192);
		for (const file of (await readdir(dumpDir)).filter(file => !before.includes(file))) {
			expect((await readFile(join(dumpDir, file), "utf8")).includes(privateText)).toBe(false);
		}
		expect(await readFile(join(dumpDir, before[0]), "utf8")).toBe(foregroundDump);
		expect(completed[0].errorMessage?.includes(privateText) ?? false).toBe(false);
		expect(c.notifications.join(" ").includes(privateText)).toBe(false);
		expect(c.status).toContain("warm off");
		expect(c.history).toHaveLength(1);
	} finally {
		await h.emit("session_shutdown", c);
		server.stop(true);
		testRuntime.mockRestore();
		logs.mockRestore();
		if (debug === undefined) delete Bun.env.PI_REQ_DEBUG;
		else Bun.env.PI_REQ_DEBUG = debug;
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
