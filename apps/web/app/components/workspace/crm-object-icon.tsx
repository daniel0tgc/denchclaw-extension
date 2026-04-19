"use client";

import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import { IconTableFilled } from "@tabler/icons-react";

/**
 * Renders a lucide icon by its kebab-case name (matches the convention used by
 * `<object>/.object.yaml` `icon:` fields, e.g. `user-plus`, `check-square`).
 *
 * Lazy-loads each icon via `lucide-react/dynamic` so the bundle stays small —
 * only icons that actually appear in a workspace's sidebar are downloaded.
 * Falls back to the Tabler table icon when `name` is missing, unknown, or
 * still loading.
 */
export function CrmObjectIcon({
	name,
	size = 16,
}: {
	name?: string | null;
	size?: number;
}) {
	const fallback = () => (
		<IconTableFilled size={size} style={{ flexShrink: 0 }} />
	);
	if (!name) return fallback();
	return (
		<DynamicIcon
			name={name as IconName}
			size={size}
			fallback={fallback}
			className="shrink-0"
		/>
	);
}
