import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveOpenClawStateDir } from "@/lib/workspace";

export const runtime = "nodejs";

function logDir(): string {
	try {
		return join(resolveOpenClawStateDir(), "debug-logs");
	} catch {
		return join(homedir(), ".openclaw-dench", "debug-logs");
	}
}

export async function GET(req: Request) {
	const url = new URL(req.url);
	const action = url.searchParams.get("action");

	const dir = logDir();

	if (action === "list") {
		try {
			const files = await readdir(dir);
			const logFiles = files
				.filter((f) => f.endsWith(".ndjson"))
				.sort()
				.reverse();

			const result = await Promise.all(
				logFiles.map(async (f) => {
					const s = await stat(join(dir, f)).catch(() => null);
					return {
						name: f,
						sizeBytes: s?.size ?? 0,
						modifiedAt: s?.mtime?.toISOString() ?? null,
					};
				}),
			);

			return Response.json({ files: result });
		} catch {
			return Response.json({ files: [] });
		}
	}

	if (action === "download") {
		const file = url.searchParams.get("file");
		if (!file || file.includes("..") || file.includes("/")) {
			return new Response("Invalid file parameter", { status: 400 });
		}
		try {
			const content = await readFile(join(dir, file), "utf-8");
			return new Response(content, {
				headers: {
					"Content-Type": "application/x-ndjson",
					"Content-Disposition": `attachment; filename="${file}"`,
				},
			});
		} catch {
			return new Response("Log file not found", { status: 404 });
		}
	}

	if (action === "download-all") {
		try {
			const files = await readdir(dir);
			const logFiles = files.filter((f) => f.endsWith(".ndjson")).sort();
			const lines: string[] = [];
			for (const f of logFiles) {
				const content = await readFile(join(dir, f), "utf-8").catch(() => "");
				if (content.trim()) {
					lines.push(content.trim());
				}
			}
			const combined = lines.join("\n") + "\n";
			return new Response(combined, {
				headers: {
					"Content-Type": "application/x-ndjson",
					"Content-Disposition": `attachment; filename="denchclaw-debug-logs.ndjson"`,
				},
			});
		} catch {
			return new Response("No logs available", { status: 404 });
		}
	}

	return Response.json(
		{ error: "Use ?action=list, ?action=download&file=..., or ?action=download-all" },
		{ status: 400 },
	);
}
