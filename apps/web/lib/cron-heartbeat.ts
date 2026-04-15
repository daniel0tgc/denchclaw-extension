import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export type HeartbeatUnit = "m" | "h" | "d";

export type HeartbeatSetting = {
	value: number;
	unit: HeartbeatUnit;
	intervalMs: number;
	raw: string;
};

const DEFAULT_INTERVAL_MS = 30 * 60_000;
const DEFAULT_SETTING: HeartbeatSetting = { value: 30, unit: "m", intervalMs: DEFAULT_INTERVAL_MS, raw: "30m" };

const UNIT_TO_MS: Record<HeartbeatUnit, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export function parseDurationString(raw: string): HeartbeatSetting | null {
	const match = raw.trim().match(/^(\d+)\s*(m|h|d)$/);
	if (!match) return null;
	const value = Number(match[1]);
	const unit = match[2] as HeartbeatUnit;
	if (!Number.isFinite(value) || value < 0) return null;
	return { value, unit, intervalMs: value * UNIT_TO_MS[unit], raw: `${value}${unit}` };
}

export function serializeDuration(value: number, unit: HeartbeatUnit): string {
	return `${value}${unit}`;
}

export function durationToMs(value: number, unit: HeartbeatUnit): number {
	return value * UNIT_TO_MS[unit];
}

type UnknownRecord = Record<string, unknown>;

function asRecord(v: unknown): UnknownRecord | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as UnknownRecord) : undefined;
}

function openClawConfigPath(): string {
	return join(resolveOpenClawStateDir(), "openclaw.json");
}

function readConfig(): UnknownRecord {
	const configPath = openClawConfigPath();
	if (!existsSync(configPath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		return asRecord(parsed) ?? {};
	} catch {
		return {};
	}
}

function writeConfig(config: UnknownRecord): void {
	const configPath = openClawConfigPath();
	const dir = join(configPath, "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Read the heartbeat `every` setting from `agents.defaults.heartbeat.every`
 * in `openclaw.json`. Falls back to `30m` if missing or invalid.
 */
export function readHeartbeatSetting(): HeartbeatSetting {
	try {
		const config = readConfig();
		const agents = asRecord(config.agents);
		const defaults = asRecord(agents?.defaults);
		const heartbeat = asRecord(defaults?.heartbeat);
		const every = heartbeat?.every;
		if (typeof every === "string") {
			return parseDurationString(every) ?? DEFAULT_SETTING;
		}
	} catch {
		// fall through
	}
	return DEFAULT_SETTING;
}

/**
 * Write the heartbeat `every` setting into `agents.defaults.heartbeat.every`
 * in `openclaw.json`, preserving all other keys.
 */
export function writeHeartbeatSetting(value: number, unit: HeartbeatUnit): HeartbeatSetting {
	const config = readConfig();

	if (!config.agents) config.agents = {};
	const agents = config.agents as UnknownRecord;

	if (!agents.defaults) agents.defaults = {};
	const defaults = agents.defaults as UnknownRecord;

	if (!defaults.heartbeat) defaults.heartbeat = {};
	const heartbeat = defaults.heartbeat as UnknownRecord;

	const raw = serializeDuration(value, unit);
	heartbeat.every = raw;

	writeConfig(config);

	return { value, unit, intervalMs: durationToMs(value, unit), raw };
}
