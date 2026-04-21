/**
 * GET /api/crm/photos/proxy?url=<google-profile-photo-url>
 *
 * Proxies Google profile photo URLs (`lh3.googleusercontent.com/a-/...`)
 * through our server so the browser can fetch them reliably. Needed
 * because Google rate-limits anonymous direct hits to those URLs from
 * localhost / non-Google origins with HTTP 429 — showing real photos
 * breaks the instant you have more than a handful of rows in the list.
 *
 * We proxy, cache aggressively, and (crucially) do the Google fetch
 * server-side without a Referer header so it isn't subject to the same
 * anti-hotlinking throttle the browser triggers.
 *
 * Only allows Google-owned hosts for the passthrough so this isn't a
 * generic SSRF escape hatch.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = new Set<string>([
	"lh3.googleusercontent.com",
	"lh4.googleusercontent.com",
	"lh5.googleusercontent.com",
	"lh6.googleusercontent.com",
	"lh3.google.com",
	"www.gravatar.com",
	"secure.gravatar.com",
]);

export async function GET(req: Request) {
	const url = new URL(req.url);
	const target = url.searchParams.get("url");
	if (!target) {
		return new Response("missing url", { status: 400 });
	}

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return new Response("invalid url", { status: 400 });
	}

	if (!ALLOWED_HOSTS.has(parsed.hostname)) {
		return new Response("host not allowed", { status: 400 });
	}

	try {
		const upstream = await fetch(parsed.toString(), {
			// Intentionally no Referer / Origin — lh3.googleusercontent.com
			// rate-limits requests with a browser-like Referer when they
			// don't originate from a Google property.
			headers: {
				"User-Agent": "DenchClaw/1.0 (+contact-photo-proxy)",
				"Accept": "image/*",
			},
			redirect: "follow",
		});

		if (!upstream.ok) {
			return new Response(`upstream ${upstream.status}`, {
				status: upstream.status,
			});
		}

		const body = await upstream.arrayBuffer();
		const contentType = upstream.headers.get("content-type") ?? "image/jpeg";

		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": contentType,
				// Profile photos are effectively immutable at a given URL —
				// when the user changes their photo Google mints a new URL.
				"Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
				"Access-Control-Allow-Origin": "*",
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(`proxy error: ${message}`, { status: 502 });
	}
}
