export const denchIntegrationsBrand = {
  displayName: "Dench Integrations",
  singularDisplayName: "Dench Integration",
  searchLabel: "Searching Dench Integrations",
  callLabel: "Calling Dench Integration",
  genericToolLabel: "Using Dench Integrations",
  attentionLabel: "Dench Integrations needs attention",
} as const;

export function formatDenchIntegrationsStatusError(
  action: "load" | "update",
  status?: number,
): string {
  const base = `Failed to ${action} ${denchIntegrationsBrand.displayName} status`;
  return typeof status === "number" ? `${base} (${status})` : `${base}.`;
}
