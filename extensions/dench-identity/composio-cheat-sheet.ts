import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shape written by `apps/web/lib/composio-tool-index.ts` to
 * `<workspace>/composio-tool-index.json`. Kept in the extension package so the
 * agent runtime can format the cheat sheet without importing the Next app.
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

type ComposioMcpStatusFile = {
  summary?: {
    verified?: boolean;
    message?: string;
  };
  config?: {
    status?: "pass" | "fail" | "unknown";
  };
  gatewayTools?: {
    status?: "pass" | "fail" | "unknown";
  };
  liveAgent?: {
    status?: "pass" | "fail" | "unknown";
  };
};

function isComposioToolIndexFile(value: unknown): value is ComposioToolIndexFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.generated_at !== "string" || !Array.isArray(rec.connected_apps)) {
    return false;
  }
  return true;
}

function isComposioToolCatalogFile(value: unknown): value is ComposioToolCatalogFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return typeof rec.generated_at === "string" && Array.isArray(rec.connected_apps);
}

/**
 * Build markdown for the identity system prompt from a parsed index file.
 */
export function formatComposioToolCheatSheetFromIndex(index: ComposioToolIndexFile): string {
  return formatComposioToolCheatSheet(index, null);
}

function formatComposioToolCheatSheet(
  index: ComposioToolIndexFile,
  status: ComposioMcpStatusFile | null,
): string {
  const verified = status?.summary?.verified === true;
  const summaryMessage = typeof status?.summary?.message === "string" ? status.summary.message : null;
  const lines: string[] = [
    "## Connected App Tools (Dench Integrations)",
    "",
    verified
      ? "You have verified Dench Integrations tools available for these connected apps. Always search first, inspect the returned full schemas and plan guidance, then execute the selected tool via `composio_call_tool`."
      : "Dench Integrations is the configured integration layer for these connected apps. If the tools are missing in this session, stop and report the Dench Integrations repair status instead of bypassing it.",
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
  if (summaryMessage) {
    lines.push(`Current verification status: ${summaryMessage}`, "");
  }

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
      lines.push(
        "**Known gotchas:**",
        ...gotchas.map(([k, v]) => `- \`${k}\`: ${v}`),
      );
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

function readComposioToolIndex(workspaceDir: string): ComposioToolIndexFile | null {
  const filePath = path.join(workspaceDir, "composio-tool-index.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return isComposioToolIndexFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function readComposioToolIndexFile(workspaceDir: string): ComposioToolIndexFile | null {
  return readComposioToolIndex(workspaceDir);
}

function readComposioToolCatalog(workspaceDir: string): ComposioToolCatalogFile | null {
  const filePath = path.join(workspaceDir, "composio-tool-catalog.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return isComposioToolCatalogFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function readComposioToolCatalogFile(workspaceDir: string): ComposioToolCatalogFile | null {
  return readComposioToolCatalog(workspaceDir);
}

function readComposioMcpStatus(workspaceDir: string): ComposioMcpStatusFile | null {
  const filePath = path.join(workspaceDir, "composio-mcp-status.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as ComposioMcpStatusFile;
    }
    return null;
  } catch {
    return null;
  }
}

export function readComposioMcpStatusFile(workspaceDir: string): ComposioMcpStatusFile | null {
  return readComposioMcpStatus(workspaceDir);
}

/**
 * Loads and formats the cheat sheet, or returns null if no index file / invalid JSON.
 */
export function loadComposioToolCheatSheetMarkdown(workspaceDir: string): string | null {
  const index = readComposioToolIndex(workspaceDir);
  if (!index || index.connected_apps.length === 0) {
    return null;
  }
  return formatComposioToolCheatSheet(index, readComposioMcpStatus(workspaceDir));
}
