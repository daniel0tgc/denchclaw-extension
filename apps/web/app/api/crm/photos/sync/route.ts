/**
 * POST /api/crm/photos/sync
 *
 * Pulls real Google profile photos for everyone the user has emailed
 * (People API → otherContacts with READ_SOURCE_TYPE_CONTACT +
 * READ_SOURCE_TYPE_PROFILE) and writes them into the Avatar URL field.
 * Uses the existing Gmail OAuth connection — no extra consent needed.
 *
 * Idempotent. Safe to call from a button, after Gmail sync, or
 * periodically.
 */

import { readConnections } from "@/lib/denchclaw-state";
import { syncGooglePhotos } from "@/lib/gmail-photo-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const connections = readConnections();
	if (!connections.gmail) {
		return Response.json(
			{ error: "No Gmail connection. Connect Gmail first to fetch profile photos." },
			{ status: 400 },
		);
	}

	try {
		const summary = await syncGooglePhotos({
			connectionId: connections.gmail.connectionId,
			signal: req.signal,
		});
		return Response.json({ ok: true, ...summary });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
