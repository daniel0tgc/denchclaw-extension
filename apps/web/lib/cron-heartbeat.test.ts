import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => "{}"),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
	homedir: vi.fn(() => "/home/testuser"),
}));

describe("cron-heartbeat helpers", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.mock("node:fs", () => ({
			existsSync: vi.fn(() => false),
			readFileSync: vi.fn(() => "{}"),
			writeFileSync: vi.fn(),
			mkdirSync: vi.fn(),
		}));
		vi.mock("node:os", () => ({
			homedir: vi.fn(() => "/home/testuser"),
		}));
	});

	describe("parseDurationString", () => {
		it("parses '30m' correctly", async () => {
			const { parseDurationString } = await import("./cron-heartbeat.js");
			const result = parseDurationString("30m");
			expect(result).toEqual({ value: 30, unit: "m", intervalMs: 1_800_000, raw: "30m" });
		});

		it("parses '2h' correctly", async () => {
			const { parseDurationString } = await import("./cron-heartbeat.js");
			const result = parseDurationString("2h");
			expect(result).toEqual({ value: 2, unit: "h", intervalMs: 7_200_000, raw: "2h" });
		});

		it("parses '1d' correctly", async () => {
			const { parseDurationString } = await import("./cron-heartbeat.js");
			const result = parseDurationString("1d");
			expect(result).toEqual({ value: 1, unit: "d", intervalMs: 86_400_000, raw: "1d" });
		});

		it("parses '0m' as zero interval", async () => {
			const { parseDurationString } = await import("./cron-heartbeat.js");
			const result = parseDurationString("0m");
			expect(result).toEqual({ value: 0, unit: "m", intervalMs: 0, raw: "0m" });
		});

		it("returns null for invalid strings", async () => {
			const { parseDurationString } = await import("./cron-heartbeat.js");
			expect(parseDurationString("")).toBeNull();
			expect(parseDurationString("abc")).toBeNull();
			expect(parseDurationString("30")).toBeNull();
			expect(parseDurationString("30x")).toBeNull();
			expect(parseDurationString("-5m")).toBeNull();
		});
	});

	describe("serializeDuration", () => {
		it("serializes value + unit", async () => {
			const { serializeDuration } = await import("./cron-heartbeat.js");
			expect(serializeDuration(15, "m")).toBe("15m");
			expect(serializeDuration(2, "h")).toBe("2h");
			expect(serializeDuration(1, "d")).toBe("1d");
		});
	});

	describe("readHeartbeatSetting", () => {
		it("returns default 30m when no config exists", async () => {
			const { readHeartbeatSetting } = await import("./cron-heartbeat.js");
			const result = readHeartbeatSetting();
			expect(result).toEqual({ value: 30, unit: "m", intervalMs: 1_800_000, raw: "30m" });
		});

		it("reads agents.defaults.heartbeat.every from config", async () => {
			const { existsSync, readFileSync } = await import("node:fs");
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					gateway: { port: 19001 },
					agents: { defaults: { heartbeat: { every: "2h" } } },
				}) as never,
			);

			const { readHeartbeatSetting } = await import("./cron-heartbeat.js");
			const result = readHeartbeatSetting();
			expect(result).toEqual({ value: 2, unit: "h", intervalMs: 7_200_000, raw: "2h" });
		});

		it("falls back to default when heartbeat.every is invalid", async () => {
			const { existsSync, readFileSync } = await import("node:fs");
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					agents: { defaults: { heartbeat: { every: "invalid" } } },
				}) as never,
			);

			const { readHeartbeatSetting } = await import("./cron-heartbeat.js");
			const result = readHeartbeatSetting();
			expect(result.value).toBe(30);
			expect(result.unit).toBe("m");
		});
	});

	describe("writeHeartbeatSetting", () => {
		it("writes heartbeat.every and preserves existing config", async () => {
			const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
			const existingConfig = {
				gateway: { port: 19001 },
				agents: { defaults: { workspace: "/ws", heartbeat: { target: "last" } } },
			};
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify(existingConfig) as never);

			const { writeHeartbeatSetting } = await import("./cron-heartbeat.js");
			const result = writeHeartbeatSetting(45, "m");

			expect(result).toEqual({ value: 45, unit: "m", intervalMs: 2_700_000, raw: "45m" });
			expect(writeFileSync).toHaveBeenCalledTimes(1);

			const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
			expect(writtenJson.gateway.port).toBe(19001);
			expect(writtenJson.agents.defaults.workspace).toBe("/ws");
			expect(writtenJson.agents.defaults.heartbeat.target).toBe("last");
			expect(writtenJson.agents.defaults.heartbeat.every).toBe("45m");
		});

		it("creates agents.defaults.heartbeat when absent", async () => {
			const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ gateway: { port: 19001 } }) as never);
			vi.mocked(writeFileSync).mockClear();

			const { writeHeartbeatSetting } = await import("./cron-heartbeat.js");
			writeHeartbeatSetting(1, "d");

			const writtenJson = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
			expect(writtenJson.agents.defaults.heartbeat.every).toBe("1d");
			expect(writtenJson.gateway.port).toBe(19001);
		});
	});
});
