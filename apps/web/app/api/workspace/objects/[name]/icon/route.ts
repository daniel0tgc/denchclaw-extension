import { findObjectDir, writeObjectYaml } from "@/lib/workspace";
// NOTE: Import from `dynamicIconImports`, NOT `lucide-react/dynamic`.
// `lucide-react/dynamic` re-exports `iconNames` from a module marked
// `"use client"`, so when this server-side route bundles it, Next's
// flight-client-entry-loader replaces the array with a client-reference
// proxy function — `new Set(iconNames)` then throws "function is not
// iterable". `dynamicIconImports` is a plain object literal with no
// `"use client"` directive, so the keys are safe to read on the server.
import dynamicIconImports from "lucide-react/dynamicIconImports";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const validIconNames: Set<string> = new Set(Object.keys(dynamicIconImports));

/**
 * PATCH /api/workspace/objects/[name]/icon
 * Set the object's display icon. Persists to `<objectDir>/.object.yaml` only —
 * the DuckDB `objects.icon` column is no longer the source of truth.
 *
 * Body: { icon: string | null }
 *   - string: a valid lucide-react kebab-case icon name (e.g. "handshake")
 *   - null:   clear the icon (renderer falls back to the Tabler table glyph)
 */
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const raw = (body as { icon?: unknown })?.icon;
	let nextIcon: string | null;
	if (raw === null) {
		nextIcon = null;
	} else if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed === "") {
			nextIcon = null;
		} else if (!/^[a-z][a-z0-9-]*$/.test(trimmed)) {
			return Response.json(
				{ error: "icon must be a kebab-case lowercase string" },
				{ status: 400 },
			);
		} else if (!validIconNames.has(trimmed)) {
			return Response.json(
				{ error: `Unknown lucide icon name: '${trimmed}'` },
				{ status: 400 },
			);
		} else {
			nextIcon = trimmed;
		}
	} else {
		return Response.json(
			{ error: "icon must be a string or null" },
			{ status: 400 },
		);
	}

	const dir = findObjectDir(name);
	if (!dir) {
		return Response.json(
			{ error: `Object '${name}' has no .object.yaml on disk` },
			{ status: 404 },
		);
	}

	// writeObjectYaml re-reads the existing file and merges, then strips any
	// keys whose value is `undefined`. So passing `{ icon: undefined }` is the
	// canonical way to delete the icon key without touching other yaml content.
	writeObjectYaml(dir, { icon: nextIcon ?? undefined });

	return Response.json({ ok: true, icon: nextIcon });
}
