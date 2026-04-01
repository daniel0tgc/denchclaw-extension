import type { ComposioConnection } from "@/lib/composio";

export type NormalizedComposioConnection = ComposioConnection & {
  normalized_toolkit_slug: string;
  normalized_status: string;
  is_active: boolean;
  account_identity: string;
  display_label: string;
};

export function normalizeComposioToolkitSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function normalizeComposioConnectionStatus(status: unknown): string {
  return typeof status === "string" && status.trim()
    ? status.trim().toUpperCase()
    : "UNKNOWN";
}

function buildComposioConnectionDisplayLabel(connection: ComposioConnection): string {
  const label = [
    connection.account_label,
    connection.account_name,
    connection.account_email,
  ].find((value) => typeof value === "string" && value.trim());

  if (label) {
    return label;
  }

  return `Connection ${connection.id.slice(-6)}`;
}

function buildComposioConnectionIdentity(connection: ComposioConnection): string {
  const stableIdentity = [
    connection.external_account_id,
    connection.account_email,
    connection.account_name,
    connection.account_label,
  ].find((value) => typeof value === "string" && value.trim());

  if (stableIdentity) {
    return `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${stableIdentity.trim().toLowerCase()}`;
  }

  return `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${connection.id}`;
}

export function normalizeComposioConnection(
  connection: ComposioConnection,
): NormalizedComposioConnection {
  const normalized_status = normalizeComposioConnectionStatus(connection.status);
  return {
    ...connection,
    normalized_toolkit_slug: normalizeComposioToolkitSlug(connection.toolkit_slug),
    normalized_status,
    is_active: normalized_status === "ACTIVE",
    account_identity: buildComposioConnectionIdentity(connection),
    display_label: buildComposioConnectionDisplayLabel(connection),
  };
}

function parseComposioConnectionTime(connection: ComposioConnection): number {
  const timestamp = Date.parse(connection.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortComposioConnections(
  left: NormalizedComposioConnection,
  right: NormalizedComposioConnection,
): number {
  if (left.is_active !== right.is_active) {
    return left.is_active ? -1 : 1;
  }

  const timeDiff = parseComposioConnectionTime(right) - parseComposioConnectionTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.display_label.localeCompare(right.display_label);
}

export function normalizeComposioConnections(
  connections: ComposioConnection[],
): NormalizedComposioConnection[] {
  return connections.map(normalizeComposioConnection).sort(sortComposioConnections);
}
