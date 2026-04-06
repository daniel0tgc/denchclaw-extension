/**
 * Structured debug logger for diagnosing tool call failures and agent loop
 * issues in production. Writes NDJSON to ~/.openclaw-dench/debug-logs/.
 *
 * Customers share these logs when they hit issues we can't reproduce locally.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveOpenClawStateDir } from "./workspace";

// ── Types ──

export type DebugLogEntry = {
	timestamp: string;
	epochMs: number;
	type:
		| "turn_start"
		| "tool_call_start"
		| "tool_call_result"
		| "tool_call_error"
		| "agent_error"
		| "lifecycle_event"
		| "loop_warning"
		| "model_fallback"
		| "gateway_error"
		| "gateway_raw_event"
		| "assistant_text"
		| "turn_end";
	sessionId: string;
	runId?: string;
	model?: string;
	modelProvider?: string;
	toolName?: string;
	toolCallId?: string;
	/** Sanitized tool call arguments (what was SENT to the tool) */
	toolInput?: unknown;
	/** Full tool result (what was RECEIVED back from the tool) */
	toolOutput?: unknown;
	/** @deprecated use toolInput */
	args?: Record<string, unknown>;
	/** @deprecated use toolOutput */
	result?: unknown;
	errorMessage?: string;
	isError?: boolean;
	durationMs?: number;
	phase?: string;
	stopReason?: string;
	/** Gateway event sequence numbers for ordering/gap detection */
	seq?: number;
	globalSeq?: number;
	/** Token usage */
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	/** How many tool calls have happened this turn */
	turnToolCallCount?: number;
	/** How many times the same tool was called consecutively this turn */
	consecutiveSameToolCount?: number;
	/** How many assistant text chunks received this turn */
	assistantChunkCount?: number;
	/** Raw gateway event data for this event */
	rawGatewayData?: unknown;
	/** Extra context */
	meta?: Record<string, unknown>;
};

// ── Per-session turn tracker ──

type ToolCallTiming = {
	startedAt: number;
	toolName: string;
};

type TurnTracker = {
	turnStartTime: number;
	toolCallCount: number;
	/** toolName → count of calls this turn */
	toolCallCounts: Map<string, number>;
	/** last N tool names to detect consecutive repeats */
	recentToolNames: string[];
	/** track active tool calls for duration */
	activeToolCalls: Map<string, ToolCallTiming>;
	/** assistant text chunk count */
	assistantChunkCount: number;
	/** accumulated assistant text (truncated for logging) */
	assistantTextPreview: string;
	model?: string;
	modelProvider?: string;
	runId?: string;
	/** last seq/globalSeq seen */
	lastSeq?: number;
	lastGlobalSeq?: number;
};

const turnTrackers = new Map<string, TurnTracker>();

const LOOP_THRESHOLD = 3;
const ASSISTANT_TEXT_PREVIEW_MAX = 500;
const MAX_LOG_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

// ── File management ──

let _logDirCreated = false;

function logDir(): string {
	try {
		return join(resolveOpenClawStateDir(), "debug-logs");
	} catch {
		return join(homedir(), ".openclaw-dench", "debug-logs");
	}
}

function logFilePath(): string {
	const date = new Date().toISOString().slice(0, 10);
	return join(logDir(), `debug-${date}.ndjson`);
}

async function ensureLogDir(): Promise<void> {
	if (_logDirCreated) return;
	await mkdir(logDir(), { recursive: true });
	_logDirCreated = true;
}

async function writeEntry(entry: DebugLogEntry): Promise<void> {
	try {
		await ensureLogDir();
		const line = JSON.stringify(entry) + "\n";
		await appendFile(logFilePath(), line, "utf-8");
	} catch {
		// Never let logging failures affect the application
	}
}

// ── Public API ──

export function onTurnStart(sessionId: string, opts: {
	model?: string;
	modelProvider?: string;
	runId?: string;
}): void {
	const tracker: TurnTracker = {
		turnStartTime: Date.now(),
		toolCallCount: 0,
		toolCallCounts: new Map(),
		recentToolNames: [],
		activeToolCalls: new Map(),
		assistantChunkCount: 0,
		assistantTextPreview: "",
		model: opts.model,
		modelProvider: opts.modelProvider,
		runId: opts.runId,
	};
	turnTrackers.set(sessionId, tracker);

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "turn_start",
		sessionId,
		runId: opts.runId,
		model: opts.model,
		modelProvider: opts.modelProvider,
	});
}

export function onToolCallStart(sessionId: string, opts: {
	toolName: string;
	toolCallId: string;
	args?: Record<string, unknown>;
	seq?: number;
	globalSeq?: number;
}): void {
	const tracker = turnTrackers.get(sessionId);
	if (tracker) {
		tracker.toolCallCount++;
		const count = (tracker.toolCallCounts.get(opts.toolName) ?? 0) + 1;
		tracker.toolCallCounts.set(opts.toolName, count);
		tracker.recentToolNames.push(opts.toolName);
		tracker.activeToolCalls.set(opts.toolCallId, {
			startedAt: Date.now(),
			toolName: opts.toolName,
		});
		if (opts.seq !== undefined) tracker.lastSeq = opts.seq;
		if (opts.globalSeq !== undefined) tracker.lastGlobalSeq = opts.globalSeq;
	}

	const consecutiveCount = tracker
		? (tracker.toolCallCounts.get(opts.toolName) ?? 1)
		: 1;

	const entry: DebugLogEntry = {
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "tool_call_start",
		sessionId,
		runId: tracker?.runId,
		model: tracker?.model,
		modelProvider: tracker?.modelProvider,
		toolName: opts.toolName,
		toolCallId: opts.toolCallId,
		toolInput: sanitizeDeep(opts.args),
		turnToolCallCount: tracker?.toolCallCount,
		consecutiveSameToolCount: consecutiveCount,
		seq: opts.seq,
		globalSeq: opts.globalSeq,
		assistantChunkCount: tracker?.assistantChunkCount,
	};

	void writeEntry(entry);

	if (consecutiveCount >= LOOP_THRESHOLD) {
		void writeEntry({
			timestamp: new Date().toISOString(),
			epochMs: Date.now(),
			type: "loop_warning",
			sessionId,
			runId: tracker?.runId,
			model: tracker?.model,
			modelProvider: tracker?.modelProvider,
			toolName: opts.toolName,
			toolCallId: opts.toolCallId,
			consecutiveSameToolCount: consecutiveCount,
			turnToolCallCount: tracker?.toolCallCount,
			meta: {
				allToolCounts: tracker
					? Object.fromEntries(tracker.toolCallCounts)
					: undefined,
				recentTools: tracker?.recentToolNames.slice(-20),
				turnElapsedMs: tracker ? Date.now() - tracker.turnStartTime : undefined,
				assistantTextPreview: tracker?.assistantTextPreview || undefined,
			},
		});
	}
}

export function onToolCallResult(sessionId: string, opts: {
	toolName: string;
	toolCallId: string;
	result?: unknown;
	isError: boolean;
	errorText?: string;
	seq?: number;
	globalSeq?: number;
	rawEventData?: Record<string, unknown>;
}): void {
	const tracker = turnTrackers.get(sessionId);
	let durationMs: number | undefined;

	if (tracker) {
		const timing = tracker.activeToolCalls.get(opts.toolCallId);
		if (timing) {
			durationMs = Date.now() - timing.startedAt;
			tracker.activeToolCalls.delete(opts.toolCallId);
		}
		if (opts.seq !== undefined) tracker.lastSeq = opts.seq;
		if (opts.globalSeq !== undefined) tracker.lastGlobalSeq = opts.globalSeq;
	}

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: opts.isError ? "tool_call_error" : "tool_call_result",
		sessionId,
		runId: tracker?.runId,
		model: tracker?.model,
		modelProvider: tracker?.modelProvider,
		toolName: opts.toolName,
		toolCallId: opts.toolCallId,
		toolOutput: capDeep(opts.result),
		isError: opts.isError,
		errorMessage: opts.errorText,
		durationMs,
		turnToolCallCount: tracker?.toolCallCount,
		consecutiveSameToolCount: tracker
			? (tracker.toolCallCounts.get(opts.toolName) ?? 0)
			: undefined,
		seq: opts.seq,
		globalSeq: opts.globalSeq,
		rawGatewayData: opts.rawEventData ? sanitizeDeep(opts.rawEventData) : undefined,
	});
}

export function onAgentError(sessionId: string, errorMessage: string, rawData?: Record<string, unknown>): void {
	const tracker = turnTrackers.get(sessionId);

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "agent_error",
		sessionId,
		runId: tracker?.runId,
		model: tracker?.model,
		modelProvider: tracker?.modelProvider,
		errorMessage,
		stopReason: typeof rawData?.stopReason === "string" ? rawData.stopReason : undefined,
		turnToolCallCount: tracker?.toolCallCount,
		assistantChunkCount: tracker?.assistantChunkCount,
		meta: {
			allToolCounts: tracker
				? Object.fromEntries(tracker.toolCallCounts)
				: undefined,
			recentTools: tracker?.recentToolNames.slice(-20),
			turnDurationMs: tracker ? Date.now() - tracker.turnStartTime : undefined,
			assistantTextPreview: tracker?.assistantTextPreview || undefined,
			rawData: rawData ? sanitizeDeep(rawData) : undefined,
		},
	});
}

export function onLifecycleEvent(sessionId: string, phase: string, data?: Record<string, unknown>): void {
	const tracker = turnTrackers.get(sessionId);

	if (tracker && data) {
		if (typeof data.model === "string") tracker.model = data.model;
		if (typeof data.modelProvider === "string") tracker.modelProvider = data.modelProvider;
		if (typeof data.provider === "string" && !tracker.modelProvider) tracker.modelProvider = data.provider;
	}

	const tokenInfo: Pick<DebugLogEntry, "inputTokens" | "outputTokens" | "totalTokens"> = {};
	if (data) {
		if (typeof data.inputTokens === "number") tokenInfo.inputTokens = data.inputTokens;
		if (typeof data.outputTokens === "number") tokenInfo.outputTokens = data.outputTokens;
		if (typeof data.totalTokens === "number") tokenInfo.totalTokens = data.totalTokens;
		const usage = data.usage as Record<string, unknown> | undefined;
		if (usage && typeof usage === "object") {
			if (typeof usage.input === "number") tokenInfo.inputTokens = usage.input;
			if (typeof usage.output === "number") tokenInfo.outputTokens = usage.output;
			if (typeof usage.input_tokens === "number") tokenInfo.inputTokens = usage.input_tokens;
			if (typeof usage.output_tokens === "number") tokenInfo.outputTokens = usage.output_tokens;
		}
	}

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "lifecycle_event",
		sessionId,
		runId: tracker?.runId ?? (typeof data?.runId === "string" ? data.runId : undefined),
		model: tracker?.model ?? (typeof data?.model === "string" ? data.model : undefined),
		modelProvider: tracker?.modelProvider ?? (typeof data?.provider === "string" ? data.provider : undefined),
		phase,
		stopReason: typeof data?.stopReason === "string" ? data.stopReason : undefined,
		...tokenInfo,
		turnToolCallCount: tracker?.toolCallCount,
		assistantChunkCount: tracker?.assistantChunkCount,
		meta: data ? sanitizeDeep(data) as Record<string, unknown> : undefined,
	});
}

export function onModelFallback(sessionId: string, opts: {
	from?: string;
	to?: string;
	reason?: string;
	rawData?: Record<string, unknown>;
}): void {
	const tracker = turnTrackers.get(sessionId);
	if (tracker && opts.to) {
		tracker.model = opts.to;
	}

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "model_fallback",
		sessionId,
		runId: tracker?.runId,
		model: opts.to,
		meta: {
			fromModel: opts.from,
			toModel: opts.to,
			reason: opts.reason,
			rawData: opts.rawData ? sanitizeDeep(opts.rawData) : undefined,
		},
	});
}

export function onGatewayError(sessionId: string, errorMessage: string, meta?: Record<string, unknown>): void {
	const tracker = turnTrackers.get(sessionId);

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "gateway_error",
		sessionId,
		runId: tracker?.runId,
		model: tracker?.model,
		modelProvider: tracker?.modelProvider,
		errorMessage,
		meta: meta ? sanitizeDeep(meta) as Record<string, unknown> : undefined,
	});
}

/**
 * Log every raw gateway event for full replay capability.
 * Only logs events that aren't already captured by the specific handlers
 * (thinking, compaction, chat, unknown events).
 */
export function onRawGatewayEvent(sessionId: string, ev: {
	event: string;
	stream?: string;
	data?: Record<string, unknown>;
	seq?: number;
	globalSeq?: number;
}): void {
	const tracker = turnTrackers.get(sessionId);
	if (tracker) {
		if (ev.seq !== undefined) tracker.lastSeq = ev.seq;
		if (ev.globalSeq !== undefined) tracker.lastGlobalSeq = ev.globalSeq;
	}

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "gateway_raw_event",
		sessionId,
		runId: tracker?.runId,
		model: tracker?.model,
		modelProvider: tracker?.modelProvider,
		seq: ev.seq,
		globalSeq: ev.globalSeq,
		meta: {
			event: ev.event,
			stream: ev.stream,
			data: ev.data ? sanitizeDeep(ev.data) : undefined,
		},
	});
}

/**
 * Track assistant text output between tool calls.
 * We don't log every delta (too noisy), but accumulate a preview and count.
 */
export function onAssistantTextDelta(sessionId: string, delta: string): void {
	const tracker = turnTrackers.get(sessionId);
	if (!tracker) return;

	tracker.assistantChunkCount++;
	if (tracker.assistantTextPreview.length < ASSISTANT_TEXT_PREVIEW_MAX) {
		tracker.assistantTextPreview += delta;
		if (tracker.assistantTextPreview.length > ASSISTANT_TEXT_PREVIEW_MAX) {
			tracker.assistantTextPreview =
				tracker.assistantTextPreview.slice(0, ASSISTANT_TEXT_PREVIEW_MAX) + "...";
		}
	}
}

/**
 * Log a summary of assistant text at natural boundaries (before a tool call,
 * or at turn end) to capture what the model said.
 */
export function flushAssistantText(sessionId: string): void {
	const tracker = turnTrackers.get(sessionId);
	if (!tracker || !tracker.assistantTextPreview) return;

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "assistant_text",
		sessionId,
		runId: tracker.runId,
		model: tracker.model,
		modelProvider: tracker.modelProvider,
		assistantChunkCount: tracker.assistantChunkCount,
		meta: {
			textPreview: tracker.assistantTextPreview,
			textLength: tracker.assistantTextPreview.length,
		},
	});

	tracker.assistantTextPreview = "";
	tracker.assistantChunkCount = 0;
}

export function onTurnEnd(sessionId: string, opts?: {
	exitCode?: number | null;
	status?: string;
}): void {
	const tracker = turnTrackers.get(sessionId);

	if (tracker?.assistantTextPreview) {
		flushAssistantText(sessionId);
	}

	void writeEntry({
		timestamp: new Date().toISOString(),
		epochMs: Date.now(),
		type: "turn_end",
		sessionId,
		runId: tracker?.runId,
		model: tracker?.model,
		modelProvider: tracker?.modelProvider,
		turnToolCallCount: tracker?.toolCallCount,
		assistantChunkCount: tracker?.assistantChunkCount,
		durationMs: tracker ? Date.now() - tracker.turnStartTime : undefined,
		meta: {
			allToolCounts: tracker
				? Object.fromEntries(tracker.toolCallCounts)
				: undefined,
			exitCode: opts?.exitCode,
			status: opts?.status,
			lastSeq: tracker?.lastSeq,
			lastGlobalSeq: tracker?.lastGlobalSeq,
		},
	});
}

export function cleanupSession(sessionId: string): void {
	turnTrackers.delete(sessionId);
}

// ── Helpers ──

const SECRET_KEYS = /key|token|secret|password|authorization|credential|api.?key/i;
const MAX_STRING_LEN = 20_000;
const MAX_PAYLOAD_JSON_LEN = 100_000;

/**
 * Recursively sanitize an object: redact keys that look like secrets,
 * cap individual strings at MAX_STRING_LEN, but otherwise preserve full data.
 */
function sanitizeDeep(value: unknown, depth = 0): unknown {
	if (depth > 10) return "[max depth]";
	if (value === undefined || value === null) return value;
	if (typeof value === "string") {
		if (value.length > MAX_STRING_LEN) {
			return value.slice(0, MAX_STRING_LEN) + `... [truncated ${value.length} chars]`;
		}
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeDeep(item, depth + 1));
	}
	if (typeof value === "object") {
		const sanitized: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			if (SECRET_KEYS.test(key)) {
				sanitized[key] = "[REDACTED]";
			} else {
				sanitized[key] = sanitizeDeep(val, depth + 1);
			}
		}
		return sanitized;
	}
	return String(value);
}

/**
 * Cap a payload to MAX_PAYLOAD_JSON_LEN when serialized.
 * Returns the value as-is if under the limit; otherwise returns
 * a truncated preview with metadata about the original size.
 */
function capDeep(value: unknown): unknown {
	if (value === undefined || value === null) return value;
	const sanitized = sanitizeDeep(value);
	try {
		const json = JSON.stringify(sanitized);
		if (json.length <= MAX_PAYLOAD_JSON_LEN) return sanitized;
		return {
			_truncated: true,
			_originalLength: json.length,
			_preview: json.slice(0, MAX_PAYLOAD_JSON_LEN),
		};
	} catch {
		return { _unserializable: true };
	}
}
