/**
 * Shared Composio response shapes kept in the extension package so the agent
 * runtime can format human-readable guidance without importing the web app.
 */
export type ComposioManagedAccount = {
  connected_account_id: string;
  account_identity: string;
  account_identity_source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  identity_confidence: "high" | "low" | "unknown";
  display_label: string;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
  related_connection_ids: string[];
  is_same_account_reconnect: boolean;
};

export type ComposioToolSummary = {
  name: string;
  title: string;
  description_short: string;
  required_args: string[];
  arg_hints: Record<string, string>;
  default_args?: Record<string, unknown>;
  example_args?: Record<string, unknown>;
  example_prompts?: string[];
  input_schema?: Record<string, unknown>;
};

export type ComposioToolIndexFile = {
  generated_at: string;
  managed_tools?: string[];
  connected_apps: Array<{
    toolkit_slug: string;
    toolkit_name: string;
    account_count: number;
    accounts?: ComposioManagedAccount[];
    tools: ComposioToolSummary[];
    recipes: Record<string, string>;
  }>;
};

export type ComposioToolCatalogFile = {
  generated_at: string;
  connected_apps: Array<{
    toolkit_slug: string;
    toolkit_name: string;
    tools: ComposioToolSummary[];
  }>;
};

/**
 * Build markdown from a parsed app/tool summary.
 */
export function formatComposioToolCheatSheetFromIndex(index: ComposioToolIndexFile): string {
  return formatComposioToolCheatSheet(index);
}

function formatComposioToolCheatSheet(index: ComposioToolIndexFile): string {
  const lines: string[] = [
    "## Connected App Tools (Dench Integrations)",
    "",
    "Dench Integrations is the configured integration layer for these connected apps. Always search first, inspect the returned full schemas and plan guidance, then execute the selected tool via `composio_call_tool`.",
    "",
    "- Use `composio_search_tools` first for every connected-app task unless you are intentionally consuming a compatibility response from `composio_resolve_tool`.",
    "- Inspect the returned full `input_schema`, `recommended_plan_steps`, `known_pitfalls`, and any pagination hints before executing anything.",
    "- Use `composio_resolve_tool` only when you specifically want a single best-match compatibility result instead of ranked search results.",
    "- After searching or resolving, execute the returned tool via `composio_call_tool` with the returned `search_context_token`, optional `search_session_id`, and final `arguments` object.",
    "- If the returned tool supports cursor fields like `starting_after`, `next_cursor`, or `page_token`, keep paginating until complete when the user asked for the full result.",
    "- Never use `gog`, shell CLIs, curl, or raw gateway HTTP as a fallback for these connected apps.",
    "- If an integration tool fails because of argument shape, fix the JSON arguments and retry once.",
    "",
  ];

  for (const app of index.connected_apps) {
    const accounts = app.accounts ?? [];
    const title =
      app.account_count > 1
        ? `### ${app.toolkit_name} (${app.account_count} accounts connected)`
        : `### ${app.toolkit_name} (1 account connected)`;
    lines.push(title, "");
    if (accounts.length > 0) {
      lines.push("**Connected accounts:**");
      for (const account of accounts.slice(0, 5)) {
        const bits = [
          account.display_label,
          account.account_email ? `email: ${account.account_email}` : null,
          `id: \`${account.connected_account_id}\``,
        ].filter(Boolean);
        lines.push(`- ${bits.join(" · ")}`);
      }
      lines.push("");
    }
    lines.push("| Intent | Tool | Key args |");
    lines.push("|--------|------|----------|");

    const recipeByTool = Object.fromEntries(
      Object.entries(app.recipes).map(([intent, tool]) => [tool, intent]),
    );

    for (const tool of app.tools) {
      const intent = recipeByTool[tool.name] ?? "—";
      const keyParts: string[] = [];
      for (const a of tool.required_args.slice(0, 4)) {
        keyParts.push(a);
      }
      const hintSample = Object.entries(tool.arg_hints).slice(0, 2);
      for (const [k, v] of hintSample) {
        keyParts.push(`${k}: ${v}`);
      }
      if (tool.default_args && Object.keys(tool.default_args).length > 0) {
        keyParts.push(`defaults: ${JSON.stringify(tool.default_args)}`);
      }
      const keyArgs = keyParts.length ? keyParts.join("; ") : "—";
      lines.push(`| ${intent} | \`${tool.name}\` | ${keyArgs} |`);
    }

    const gotchas = Object.entries(
      app.tools.reduce<Record<string, string>>((acc, t) => {
        for (const [k, v] of Object.entries(t.arg_hints)) {
          if (!acc[k]) {
            acc[k] = v;
          }
        }
        return acc;
      }, {}),
    );
    if (gotchas.length > 0) {
      lines.push("");
      lines.push("**Known gotchas:**", ...gotchas.map(([k, v]) => `- \`${k}\`: ${v}`));
    }

    const extraRecipes = Object.entries(app.recipes).filter(
      ([, toolName]) => !app.tools.some((t) => t.name === toolName),
    );
    if (extraRecipes.length > 0) {
      lines.push("");
      lines.push("**More intents (tool may be outside the curated direct-tool list):**");
      for (const [intent, toolName] of extraRecipes) {
        lines.push(`- ${intent}: \`${toolName}\``);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
