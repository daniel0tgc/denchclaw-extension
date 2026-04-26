import {
	type HeartbeatUnit,
	durationToMs,
	readHeartbeatSetting,
	writeHeartbeatSetting,
} from "@/lib/cron-heartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VALID_UNITS = new Set<HeartbeatUnit>(["m", "h", "d"]);

const MAX_VALUES: Record<HeartbeatUnit, number> = {
	m: 1440,
	h: 168,
	d: 30,
};

type PostBody = {
	value?: unknown;
	unit?: unknown;
};

/** GET /api/cron/heartbeat — return the current heartbeat setting. */
export async function GET() {
	const setting = readHeartbeatSetting();
	return Response.json(setting);
}

/** POST /api/cron/heartbeat — update `agents.defaults.heartbeat.every`. */
export async function POST(req: Request) {
	let body: PostBody;
	try {
		body = (await req.json()) as PostBody;
	} catch {
		return Response.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const { value, unit } = body;

	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
		return Response.json({ error: "Field 'value' must be a positive integer." }, { status: 400 });
	}

	if (typeof unit !== "string" || !VALID_UNITS.has(unit as HeartbeatUnit)) {
		return Response.json({ error: "Field 'unit' must be one of 'm', 'h', or 'd'." }, { status: 400 });
	}

	const typedUnit = unit as HeartbeatUnit;

	if (value > MAX_VALUES[typedUnit]) {
		return Response.json(
			{ error: `Value exceeds maximum of ${MAX_VALUES[typedUnit]}${typedUnit}.` },
			{ status: 400 },
		);
	}

	const ms = durationToMs(value, typedUnit);
	if (ms < 60_000) {
		return Response.json({ error: "Heartbeat interval must be at least 1 minute." }, { status: 400 });
	}

	try {
		const setting = writeHeartbeatSetting(value, typedUnit);
		return Response.json(setting);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Failed to save heartbeat setting." },
			{ status: 500 },
		);
	}
}
