import type { PathOrFileDescriptor } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/active-runs", () => ({
	startSubscribeRun: vi.fn(() => ({ status: "completed" })),
	getActiveRun: vi.fn(),
	subscribeToRun: vi.fn(() => () => {}),
	reactivateSubscribeRun: vi.fn(() => true),
}));

vi.mock("@/lib/workspace", () => ({
	resolveWorkspaceRoot: vi.fn(() => "/home/testuser/.openclaw-dench/workspace"),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn((_path: PathOrFileDescriptor, options?: unknown) =>
		typeof options === "string" ? "{}" : Buffer.from(""),
	),
}));

describe("POST /api/gateway/chat", () => {
	beforeEach(async () => {
		vi.resetModules();
		const { getActiveRun, subscribeToRun, startSubscribeRun, reactivateSubscribeRun } = await import("@/lib/active-runs");
		vi.mocked(getActiveRun).mockReset();
		vi.mocked(getActiveRun).mockReturnValue(undefined);
		vi.mocked(subscribeToRun).mockReset();
		vi.mocked(subscribeToRun).mockReturnValue(() => {});
		vi.mocked(startSubscribeRun).mockReset();
		vi.mocked(startSubscribeRun).mockReturnValue({ status: "completed" } as never);
		vi.mocked(reactivateSubscribeRun).mockReset();
		vi.mocked(reactivateSubscribeRun).mockReturnValue(true);

		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReset();
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockReset();
		vi.mocked(readFileSync).mockImplementation((_path: PathOrFileDescriptor, options?: unknown) =>
			typeof options === "string" ? "{}" : Buffer.from(""),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hydrates attached images before reactivating the gateway run", async () => {
		const { getActiveRun, reactivateSubscribeRun } = await import("@/lib/active-runs");
		vi.mocked(getActiveRun).mockReturnValue({ status: "completed" } as never);

		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((_path: PathOrFileDescriptor, options?: unknown) =>
			typeof options === "string" ? "{}" : Buffer.from("gateway-image")
		);

		const { POST } = await import("./route.js");
		const req = new Request("http://localhost/api/gateway/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "gateway-thread",
				message: "[Attached files: assets/gateway.png]\n\nread this",
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(200);
		expect(reactivateSubscribeRun).toHaveBeenCalledWith(
			"gateway-thread",
			expect.stringContaining("assets/gateway.png"),
			[
				expect.objectContaining({
					fileName: "gateway.png",
					mimeType: "image/png",
					content: Buffer.from("gateway-image").toString("base64"),
				}),
			],
		);
	});

	it("rejects oversized gateway image attachments", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((_path: PathOrFileDescriptor, options?: unknown) =>
			typeof options === "string" ? "{}" : Buffer.alloc(5 * 1024 * 1024 + 1)
		);

		const { reactivateSubscribeRun } = await import("@/lib/active-runs");
		const { POST } = await import("./route.js");
		const req = new Request("http://localhost/api/gateway/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "gateway-thread",
				message: "[Attached files: assets/too-large.png]",
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("exceeds the 5 MB limit");
		expect(reactivateSubscribeRun).not.toHaveBeenCalled();
	});
});
