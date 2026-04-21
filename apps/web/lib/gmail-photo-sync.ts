/**
 * Fetches real Google profile photos for everyone in the user's Gmail
 * contacts (saved + "Other Contacts" — i.e. people they've emailed)
 * and writes them into the People table's `Avatar URL` field.
 *
 * Uses Composio's `GMAIL_GET_PEOPLE` tool with the People API
 * "otherContacts" endpoint. To surface real profile photos (not the
 * generic letter stub) we have to pass BOTH source types on the
 * request — this is the Google People API quirk documented in
 * https://developers.google.com/people/api/rest/v1/otherContacts/list
 *   sources: READ_SOURCE_TYPE_CONTACT  — lets us ask for `photos`
 *   sources: READ_SOURCE_TYPE_PROFILE  — promotes the stub URL to the
 *                                         actual profile photo
 *
 * The existing Gmail OAuth scope already authorizes this — no extra
 * integration, no extra consent screen. Gets Kumar's real Google
 * profile photo instead of the dench.com favicon fallback.
 */

import {
	executeComposioTool,
	resolveToolSlug,
	createConcurrencyLimiter,
	ComposioToolNoConnectionError,
} from "./composio-execute";
import {
	duckdbExecAsync,
	duckdbQueryAllAsync,
} from "./workspace";

// ---------------------------------------------------------------------------
// Types mirroring the People API response shape
// ---------------------------------------------------------------------------

type GooglePhoto = {
	url?: string;
	default?: boolean;
	metadata?: {
		primary?: boolean;
		source?: { type?: string; id?: string };
	};
};

type GoogleEmailAddress = {
	value?: string;
	metadata?: { primary?: boolean; source?: { type?: string } };
};

type GooglePerson = {
	resourceName?: string;
	etag?: string;
	emailAddresses?: GoogleEmailAddress[];
	photos?: GooglePhoto[];
};

type GmailGetPeopleResponse = {
	data?: {
		otherContacts?: GooglePerson[];
		nextPageToken?: string;
		nextSyncToken?: string;
		totalSize?: number;
	} | GooglePerson[] | {
		connections?: GooglePerson[];
		nextPageToken?: string;
	};
	error?: string;
	successful?: boolean;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type PhotoSyncSummary = {
	/** People records that got a fresh Avatar URL from Google. */
	photosWritten: number;
	/** Unique emails seen across all pages (sanity check). */
	contactsSeen: number;
	/** Whether we hit the last page or stopped early (aborted, error). */
	reachedEnd: boolean;
};

export type PhotoSyncOptions = {
	connectionId: string;
	signal?: AbortSignal;
	/** Cap pages fetched so a giant contact list doesn't block the UI forever. */
	maxPages?: number;
	onProgress?: (delta: { page: number; photosWritten: number }) => void;
};

const DEFAULT_MAX_PAGES = 10;
const PAGE_SIZE = 500;

/**
 * Pull otherContacts via People API (through Composio), extract the
 * best-available photo per email, and write it into the People table.
 *
 * Safe to run repeatedly — writes are idempotent (delete + insert for
 * the Avatar URL field). Skips records where no usable photo is found
 * (default stubs are filtered out so we don't overwrite a real stored
 * URL with a Google placeholder).
 */
export async function syncGooglePhotos(opts: PhotoSyncOptions): Promise<PhotoSyncSummary> {
	const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

	const [peopleFieldMap, emailToEntryId] = await Promise.all([
		loadPeopleFieldMap(),
		loadEmailToEntryIdMap(),
	]);

	const avatarFieldId = peopleFieldMap["Avatar URL"];
	if (!avatarFieldId) {
		// Workspace is older than the Avatar URL migration — nothing to do.
		return { photosWritten: 0, contactsSeen: 0, reachedEnd: true };
	}

	const slug = await resolveToolSlug({
		toolkitSlug: "gmail",
		preferredSlugs: ["GMAIL_GET_PEOPLE"],
		signal: opts.signal,
	});

	let pageToken: string | null = null;
	let photosWritten = 0;
	let contactsSeen = 0;
	let reachedEnd = false;

	for (let page = 0; page < maxPages; page += 1) {
		if (opts.signal?.aborted) {break;}

		let result;
		try {
			result = await executeComposioTool<GmailGetPeopleResponse>({
				toolSlug: slug,
				connectedAccountId: opts.connectionId,
				arguments: {
					other_contacts: true,
					page_size: PAGE_SIZE,
					page_token: pageToken ?? "",
					// BOTH sources required — see file header comment.
					sources: ["READ_SOURCE_TYPE_CONTACT", "READ_SOURCE_TYPE_PROFILE"],
					person_fields: "emailAddresses,photos,metadata",
				},
				signal: opts.signal,
				context: "gmail-get-people",
			});
		} catch (err) {
			if (err instanceof ComposioToolNoConnectionError) {
				// No Gmail connection — user hasn't completed onboarding. Not
				// an error, just skip.
				return { photosWritten, contactsSeen, reachedEnd: true };
			}
			throw err;
		}

		const payload: unknown = result.data?.data ?? result.data;
		const contacts: GooglePerson[] = extractContacts(payload);

		const updates: Array<{ entryId: string; avatarUrl: string }> = [];
		for (const person of contacts) {
			contactsSeen += 1;
			const avatarUrl = pickBestPhoto(person.photos ?? []);
			if (!avatarUrl) {continue;}

			const emails = (person.emailAddresses ?? [])
				.map((e) => (typeof e.value === "string" ? e.value.toLowerCase().trim() : ""))
				.filter((v): v is string => v.length > 0);
			if (emails.length === 0) {continue;}

			for (const email of emails) {
				const entryId = emailToEntryId.get(email);
				if (!entryId) {continue;}
				updates.push({ entryId, avatarUrl });
			}
		}

		if (updates.length > 0) {
			photosWritten += await writeAvatarUrls({
				avatarFieldId,
				updates,
			});
		}

		opts.onProgress?.({ page: page + 1, photosWritten });

		const nextToken = extractNextPageToken(payload);
		if (!nextToken) {
			reachedEnd = true;
			break;
		}
		pageToken = nextToken;
	}

	return { photosWritten, contactsSeen, reachedEnd };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PEOPLE_OBJECT_ID = "seed_obj_people_00000000000000";

/**
 * Composio's `GMAIL_GET_PEOPLE` can return the People API payload in
 * a couple of shapes depending on which code path it hit; normalize
 * them here so the caller doesn't have to care.
 */
function extractContacts(payload: unknown): GooglePerson[] {
	if (Array.isArray(payload)) {return payload as GooglePerson[];}
	if (payload && typeof payload === "object") {
		const obj = payload as { otherContacts?: unknown; connections?: unknown };
		if (Array.isArray(obj.otherContacts)) {return obj.otherContacts as GooglePerson[];}
		if (Array.isArray(obj.connections)) {return obj.connections as GooglePerson[];}
	}
	return [];
}

function extractNextPageToken(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") {return null;}
	const token = (payload as { nextPageToken?: unknown }).nextPageToken;
	return typeof token === "string" && token.length > 0 ? token : null;
}

async function loadPeopleFieldMap(): Promise<Record<string, string>> {
	const rows = await duckdbQueryAllAsync<{ name: string; id: string }>(
		`SELECT name, id FROM fields WHERE object_id = '${PEOPLE_OBJECT_ID}'`,
		"name",
	);
	const out: Record<string, string> = {};
	for (const row of rows) {
		if (row.name && row.id) {out[row.name] = row.id;}
	}
	return out;
}

async function loadEmailToEntryIdMap(): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	const fieldMap = await loadPeopleFieldMap();
	const emailFieldId = fieldMap["Email Address"];
	if (!emailFieldId) {return map;}

	const rows = await duckdbQueryAllAsync<{ entry_id: string; value: string }>(
		`SELECT entry_id, value FROM entry_fields WHERE field_id = '${emailFieldId}'`,
	);
	for (const row of rows) {
		if (!row.value) {continue;}
		const key = row.value.toLowerCase().trim();
		if (key) {map.set(key, row.entry_id);}
	}
	return map;
}

/**
 * Google returns multiple photo entries per person. We want the PROFILE
 * one (a real photo the user uploaded), not the generic CONTACT one
 * which is usually the letter-on-coloured-background stub Google
 * auto-generates. `default: true` also marks stubs.
 */
function pickBestPhoto(photos: GooglePhoto[]): string | null {
	if (photos.length === 0) {return null;}
	// 1st preference: PROFILE source, non-default, has url.
	for (const photo of photos) {
		if (photo.default) {continue;}
		if (photo.metadata?.source?.type === "PROFILE" && photo.url) {
			return photo.url;
		}
	}
	// 2nd: any non-default photo with a url.
	for (const photo of photos) {
		if (photo.default) {continue;}
		if (photo.url) {return photo.url;}
	}
	return null;
}

/**
 * Idempotent upsert of Avatar URL. entry_fields has UNIQUE(entry_id,
 * field_id) so we DELETE + INSERT to guarantee a single row per
 * (person, field) even across repeated photo syncs.
 */
async function writeAvatarUrls(params: {
	avatarFieldId: string;
	updates: Array<{ entryId: string; avatarUrl: string }>;
}): Promise<number> {
	if (params.updates.length === 0) {return 0;}
	// Build one batched multi-statement so we take the duckdb file lock
	// exactly once instead of spawning a CLI process per row.
	const lines: string[] = ["BEGIN;"];
	for (const { entryId, avatarUrl } of params.updates) {
		const escapedId = entryId.replace(/'/g, "''");
		const escapedUrl = avatarUrl.replace(/'/g, "''");
		lines.push(
			`DELETE FROM entry_fields WHERE entry_id = '${escapedId}' AND field_id = '${params.avatarFieldId}';`,
		);
		lines.push(
			`INSERT INTO entry_fields (entry_id, field_id, value) VALUES ('${escapedId}', '${params.avatarFieldId}', '${escapedUrl}');`,
		);
	}
	lines.push("COMMIT;");
	const ok = await duckdbExecAsync(lines.join("\n"));
	return ok ? params.updates.length : 0;
}

// concurrency limiter kept imported in case callers run this alongside
// other long-lived duckdb writes; for the sync itself we batch into a
// single transaction so it isn't needed.
void createConcurrencyLimiter;
