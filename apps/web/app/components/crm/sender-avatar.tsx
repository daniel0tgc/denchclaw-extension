"use client";

import { useState } from "react";
import { PersonAvatar } from "./person-avatar";
import { CompanyFavicon } from "./company-favicon";

/**
 * Known consumer email providers. Senders from these domains are ~always
 * individuals, even if the sender-type classifier wasn't run yet — showing
 * the Gmail/Yahoo/etc. logo instead of initials feels generic and wrong.
 */
const CONSUMER_DOMAINS = new Set<string>([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"yahoo.co.uk",
	"yahoo.co.jp",
	"hotmail.com",
	"hotmail.co.uk",
	"outlook.com",
	"live.com",
	"msn.com",
	"icloud.com",
	"me.com",
	"mac.com",
	"aol.com",
	"proton.me",
	"protonmail.com",
	"pm.me",
	"fastmail.com",
	"gmx.com",
	"gmx.de",
	"zoho.com",
	"mail.com",
	"mail.ru",
	"yandex.com",
	"qq.com",
	"163.com",
	"126.com",
]);

function extractDomain(email: string | null | undefined): string | null {
	if (!email) {return null;}
	const at = email.lastIndexOf("@");
	if (at < 0 || at === email.length - 1) {return null;}
	return email.slice(at + 1).trim().toLowerCase() || null;
}

/**
 * Hosts whose images Google / Gravatar will 429 or hotlink-block when
 * fetched with a non-Google Referer. Route those through our image
 * proxy so the request picks up server-side caching + no-Referer.
 */
const PROXIED_HOSTS = new Set<string>([
	"lh3.googleusercontent.com",
	"lh4.googleusercontent.com",
	"lh5.googleusercontent.com",
	"lh6.googleusercontent.com",
	"lh3.google.com",
	"www.gravatar.com",
	"secure.gravatar.com",
]);

function viaProxyIfNeeded(url: string): string {
	try {
		const parsed = new URL(url);
		if (PROXIED_HOSTS.has(parsed.hostname)) {
			return `/api/crm/photos/proxy?url=${encodeURIComponent(url)}`;
		}
	} catch {
		// not a parseable URL — let it through as-is
	}
	return url;
}

function extractLocalPart(email: string | null | undefined): string | null {
	if (!email) {return null;}
	const at = email.lastIndexOf("@");
	if (at <= 0) {return null;}
	return email.slice(0, at).trim().toLowerCase() || null;
}

/**
 * Local-parts that signal an automated/bulk sender rather than a human.
 * When we match one of these we show the domain favicon (the "brand"),
 * because showing "NO" initials for `noreply@stripe.com` would be useless.
 */
const BULK_LOCAL_PARTS = new Set<string>([
	"noreply", "no-reply", "do-not-reply", "donotreply",
	"notifications", "notification", "notify",
	"alerts", "alert",
	"billing", "invoices", "invoice", "receipts", "receipt",
	"support", "help", "contact", "info", "hello",
	"team", "hi", "news", "newsletter", "updates",
	"mail", "mailer", "mailing",
	"automated", "auto", "system", "admin",
	"security", "account", "accounts",
	"orders", "order", "shipping",
]);

function looksLikeBulkSender(email: string | null | undefined, name: string | null | undefined): boolean {
	const local = extractLocalPart(email);
	if (local && BULK_LOCAL_PARTS.has(local)) {return true;}
	// Prefix like `no-reply-abc123@...` or `notifications+xyz@...`
	if (local) {
		const head = local.split(/[+.\-_]/)[0];
		if (head && BULK_LOCAL_PARTS.has(head)) {return true;}
	}
	// Display name that obviously isn't a person ("Y Combinator", "Stripe",
	// "The Google Workspace Team"). Simple heuristic: no lowercase-name
	// pattern AND doesn't look like "First Last".
	if (name) {
		const trimmed = name.trim();
		// "Team", "Notifications", "Security" etc. as standalone names
		if (/^(the\s+)?(\w+\s+)?(team|notifications?|security|alerts?|billing|support|updates?)$/i.test(trimmed)) {
			return true;
		}
	}
	return false;
}

/**
 * Picks the right avatar rendering for an email sender (Gmail/Superhuman
 * style). Fallback cascade (stops at the first one that succeeds):
 *
 *   1. A stored `avatar_url` (Gmail contact photo, manually set URL, etc.).
 *   2. Gravatar via unavatar.io — covers almost every professional email
 *      that's registered on Gravatar / GitHub / Twitter, so you see a
 *      real face instead of coloured initials.
 *   3. For corporate domains (not gmail/outlook/etc.), the domain favicon
 *      via Google's s2 service — so `team@ycombinator.com` renders as the
 *      YC logo without needing the sender-type classifier.
 *   4. A coloured initials monogram as the last-resort fallback.
 *
 * Each step uses React `onError` to fall through, so broken URLs don't
 * leave a broken-image icon.
 */
export function SenderAvatar(props: {
	name?: string | null;
	email?: string | null;
	avatarUrl?: string | null;
	/** Kept for API compatibility; no longer used to gate the favicon. */
	senderType?: string | null;
	seed?: string | null;
	size?: "sm" | "md" | "lg" | "xl";
	className?: string;
}) {
	const { name, email, avatarUrl, seed, size = "sm", className } = props;

	// Tier failures (image load errors) are tracked so we can fall back in
	// priority order: stored url → gravatar → domain favicon → initials.
	const [primaryFailed, setPrimaryFailed] = useState(false);
	const [gravatarFailed, setGravatarFailed] = useState(false);

	const cleanedAvatarUrl = typeof avatarUrl === "string" && avatarUrl.trim()
		? avatarUrl.trim()
		: null;

	// Tier 1 — explicit avatar URL.
	if (cleanedAvatarUrl && !primaryFailed) {
		return (
			<PersonAvatar
				src={viaProxyIfNeeded(cleanedAvatarUrl)}
				name={name}
				seed={seed ?? email}
				size={size}
				className={className}
				onError={() => setPrimaryFailed(true)}
			/>
		);
	}

	// Tier 2 — Gravatar via unavatar.io. `fallback=false` returns 404 when
	// the email isn't registered anywhere, which flips us to Tier 3.
	if (email && !gravatarFailed) {
		const gravatarUrl = `https://unavatar.io/${encodeURIComponent(email)}?fallback=false`;
		return (
			<PersonAvatar
				src={gravatarUrl}
				name={name}
				seed={seed ?? email}
				size={size}
				className={className}
				onError={() => setGravatarFailed(true)}
			/>
		);
	}

	// Tier 3 — domain favicon, but ONLY for senders that look like bulk /
	// automated mail (noreply@, notifications@, "Team" names, etc.).
	// Real humans at a corporate domain (kumar@dench.com, mark@dench.com)
	// should fall through to initials — the dench.com favicon is not
	// *their* avatar, it's the company logo, and using it here makes
	// every coworker look identical.
	const domain = extractDomain(email);
	if (
		domain &&
		!CONSUMER_DOMAINS.has(domain) &&
		looksLikeBulkSender(email, name)
	) {
		return (
			<CompanyFavicon
				domain={domain}
				name={name}
				size={size}
				className={className}
			/>
		);
	}

	// Tier 4 — initials.
	return (
		<PersonAvatar
			name={name}
			seed={seed ?? email}
			size={size}
			className={className}
		/>
	);
}
