"use client";

import { useEffect, useMemo, useState } from "react";
import {
	SiGmail,
	SiGooglecalendar,
	SiNotion,
	SiSlack,
} from "react-icons/si";
import type {
	ComposioConnection,
	ComposioConnectionsResponse,
	ComposioToolkit,
	ComposioToolkitsResponse,
} from "@/lib/composio";
import {
	extractComposioConnections,
	extractComposioToolkits,
	normalizeComposioConnections,
} from "@/lib/composio-client";
import { buildFileLink } from "@/lib/workspace-links";

const SNAPSHOT_STORAGE_KEY = "composio-connected-apps-snapshot";

type ConnectedAppsSnapshot = {
	connectedToolkits?: ComposioToolkit[];
	connections?: ComposioConnection[];
};

type RecommendedApp = {
	slug: string;
	label: string;
	fallbackIcon: typeof SiGmail;
	fallbackColor: string;
};

const RECOMMENDED_APPS = [
	{ slug: "gmail", label: "Gmail", fallbackIcon: SiGmail, fallbackColor: "#EA4335" },
	{ slug: "google-calendar", label: "Calendar", fallbackIcon: SiGooglecalendar, fallbackColor: "#4285F4" },
	{ slug: "slack", label: "Slack", fallbackIcon: SiSlack, fallbackColor: "#E01E5A" },
	{ slug: "notion", label: "Notion", fallbackIcon: SiNotion, fallbackColor: "#111111" },
] as const satisfies readonly RecommendedApp[];

function hasAnyActiveConnections(connections: ComposioConnection[]): boolean {
	return normalizeComposioConnections(connections).some((connection) => connection.is_active);
}

function loadSnapshotHasConnectedApps(): boolean {
	try {
		const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
		if (!raw) {return false;}
		const parsed = JSON.parse(raw) as ConnectedAppsSnapshot;
		return hasAnyActiveConnections(parsed.connections ?? []);
	} catch {
		return false;
	}
}

function persistSnapshot(
	toolkits: ComposioToolkit[],
	connections: ComposioConnection[],
): void {
	try {
		localStorage.setItem(
			SNAPSHOT_STORAGE_KEY,
			JSON.stringify({
				connectedToolkits: toolkits,
				connections,
			} satisfies ConnectedAppsSnapshot),
		);
	} catch {
		// Best-effort cache only.
	}
}

export function HeroRecommendedAppsBadge({
	onNavigate,
	forceVisible = false,
	className = "",
}: {
	onNavigate?: () => void;
	forceVisible?: boolean;
	className?: string;
}) {
	const [hasConnectedApps, setHasConnectedApps] = useState(false);
	const [toolkitLogoMap, setToolkitLogoMap] = useState<Record<string, string>>({});

	useEffect(() => {
		setHasConnectedApps(loadSnapshotHasConnectedApps());
		let cancelled = false;

		void (async () => {
			try {
				const [connectionsRes, toolkitsRes] = await Promise.all([
					fetch("/api/composio/connections?include_toolkits=1", {
						cache: "no-store",
					}),
					fetch("/api/composio/toolkits?limit=24", {
						cache: "force-cache",
					}),
				]);
				if (!connectionsRes.ok) {return;}
				const payload = await connectionsRes.json() as ComposioConnectionsResponse & {
					toolkits?: ComposioToolkit[];
				};
				const connections = extractComposioConnections(payload);
				persistSnapshot(payload.toolkits ?? [], connections);
				if (!cancelled) {
					setHasConnectedApps(hasAnyActiveConnections(connections));
				}

				if (!toolkitsRes.ok) {return;}
				const toolkitsPayload = (await toolkitsRes.json()) as ComposioToolkitsResponse;
				const toolkitItems = extractComposioToolkits(toolkitsPayload).items;
				if (!cancelled) {
					setToolkitLogoMap(
						Object.fromEntries(
							toolkitItems
								.filter((toolkit) => toolkit.logo)
								.map((toolkit) => [toolkit.slug, toolkit.logo as string]),
						),
					);
				}
			} catch {
				// Best-effort only; keep the cached/default state.
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	const handleClick = useMemo(
		() => onNavigate ?? (() => window.location.assign(buildFileLink("~integrations"))),
		[onNavigate],
	);

	if (hasConnectedApps && !forceVisible) {return null;}

	return (
		<div className={`flex w-full justify-center px-4 ${className}`}>
			<button
				type="button"
				onClick={handleClick}
				className="inline-flex items-center gap-2.5 rounded-full border px-3 py-1.5 transition-all hover:opacity-90"
				style={{
					background: "color-mix(in srgb, var(--color-surface) 50%, transparent)",
					borderColor: "color-mix(in srgb, var(--color-border) 58%, transparent)",
					boxShadow: "0 8px 22px rgba(0,0,0,0.045)",
					backdropFilter: "blur(12px)",
				}}
				aria-label="Connect recommended apps"
				title="Open integrations"
			>
				<span
					className="text-[11px] md:text-xs font-medium"
					style={{ color: "var(--color-text-secondary)" }}
				>
					Connect recommended apps
				</span>
				<div
					className="h-4 w-px shrink-0"
					style={{ background: "color-mix(in srgb, var(--color-border) 75%, transparent)" }}
					aria-hidden="true"
				/>
				<div className="flex items-center gap-1.5">
					{RECOMMENDED_APPS.map(({ slug, label, fallbackIcon: FallbackIcon, fallbackColor }) => (
						<div
							key={slug}
							className="flex h-4 w-auto items-center justify-center"
							title={label}
							aria-hidden="true"
						>
							{toolkitLogoMap[slug]
								? (
									<img
										src={toolkitLogoMap[slug]}
										alt=""
										className="block h-4 w-auto object-contain"
										loading="lazy"
									/>
								)
								: <FallbackIcon size={14} color={fallbackColor} />}
						</div>
					))}
				</div>
			</button>
		</div>
	);
}
