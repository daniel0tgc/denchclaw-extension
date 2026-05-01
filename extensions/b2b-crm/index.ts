import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrations.js";
import { createObjects, createPivotViews, createObjectYamlFiles } from "./objects.js";
import { createStandaloneTables } from "./tables.js";
import { setupFTSIndexes } from "./fts.js";
import { createMockCloud } from "./mock-cloud.js";
import { createSyncQueueService } from "./sync-queue.js";
import { registerSyncPushTool } from "./sync-push.js";
import { registerSyncPullTool } from "./sync-pull.js";
import { registerSyncStatusTool } from "./sync-status.js";
import { createHLC } from "./hlc.js";
import { importCSV, type ColumnMapping } from "./csv-import.js";
import { exportCSV } from "./csv-export.js";
import type { FilterGroup } from "./filters.js";

export const id = "b2b-crm";

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = api.config?.plugins?.entries?.[id]?.config as Record<string, unknown> | undefined;
  if (pluginConfig?.enabled === false) return;

  const defaultWorkspace = join(homedir(), ".openclaw-dench", "workspace");
  const workspacePath = (pluginConfig?.["workspacePath"] as string | undefined) ?? defaultWorkspace;
  const dbPath = join(workspacePath, "workspace.duckdb");
  const cloudDbPath = join(workspacePath, "workspace-cloud.duckdb");
  const nodeId = (pluginConfig?.["nodeId"] as string | undefined) ?? "local";
  const syncIntervalMs = (pluginConfig?.["syncIntervalMs"] as number | undefined) ?? 30000;

  api.logger.info("[b2b-crm] Extension loading...");

  // Initialize DB schema, EAV objects, PIVOT views, FTS indexes, and YAML files.
  // Fire-and-forget — errors are logged so the extension still loads.
  void (async () => {
    try {
      await runMigrations([]);
      await createStandaloneTables(dbPath);
      await createObjects(dbPath);
      await createPivotViews(dbPath);
      await setupFTSIndexes(dbPath);
      createObjectYamlFiles(workspacePath);
      api.logger.info("[b2b-crm] Schema initialized");
    } catch (err) {
      api.logger.info(`[b2b-crm] Init error: ${String(err)}`);
    }
  })();

  // Sync infrastructure
  let localHlc = createHLC(nodeId);
  const cloud = createMockCloud(cloudDbPath);
  const syncService = createSyncQueueService(cloud, nodeId, dbPath, workspacePath);

  // Sync tools
  registerSyncPushTool(api, () => localHlc, nodeId, dbPath);
  registerSyncPullTool(api, syncService);
  registerSyncStatusTool(api, syncService, dbPath);

  // Background sync drain service
  api.registerService({
    id: "b2b-crm-sync-drain",
    start: async () => {
      // Keep localHlc up-to-date from plugin config context
      localHlc = createHLC(nodeId);
      syncService.start(syncIntervalMs);
    },
    stop: async () => {
      syncService.stop();
    },
  });

  // CSV import tool
  api.registerTool({
    name: "b2b_crm_import_csv",
    label: "B2B CRM Import CSV",
    description:
      "Import accounts, contacts, or deals from CSV. Validates each row, skips bad rows with error log, returns import summary.",
    parameters: {
      type: "object",
      required: ["csvContent", "objectName", "mappings"],
      properties: {
        csvContent: { type: "string", description: "Raw CSV content as a string" },
        objectName: {
          type: "string",
          enum: ["account", "contact", "deal"],
          description: "Object type to import into",
        },
        mappings: {
          type: "array",
          description: "Column mappings from CSV header name to CRM field name",
          items: {
            type: "object",
            properties: {
              csvColumn: { type: "string" },
              objectField: { type: "string" },
            },
          },
        },
        skipHeader: { type: "boolean", description: "Skip first row as header. Default true." },
        dedup: { type: "boolean", description: "Skip duplicate records. Default false." },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await importCSV(
        params["csvContent"] as string,
        params["objectName"] as string,
        params["mappings"] as ColumnMapping[],
        {
          skipHeader: (params["skipHeader"] as boolean | undefined) ?? true,
          dedup: (params["dedup"] as boolean | undefined) ?? false,
          dbPath,
        },
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  } as AnyAgentTool);

  // CSV export tool
  api.registerTool({
    name: "b2b_crm_export_csv",
    label: "B2B CRM Export CSV",
    description:
      "Export accounts, contacts, or deals as RFC 4180 CSV with optional field selection and filter.",
    parameters: {
      type: "object",
      required: ["objectName"],
      properties: {
        objectName: {
          type: "string",
          enum: ["account", "contact", "deal"],
          description: "Object type to export",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Field names to include. Omit for all fields.",
        },
        filter: {
          type: "object",
          description: "Optional FilterGroup to limit exported rows.",
        },
      },
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const csv = await exportCSV(
        params["objectName"] as string,
        params["fields"] as string[] | undefined,
        params["filter"] as FilterGroup | undefined,
        dbPath,
      );
      const rowCount = csv.split("\n").filter(Boolean).length - 1;
      return {
        content: [{ type: "text" as const, text: csv }],
        details: { rows: rowCount },
      };
    },
  } as AnyAgentTool);

  api.logger.info("[b2b-crm] Extension loaded");
}
