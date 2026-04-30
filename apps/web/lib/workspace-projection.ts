import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import type { ObjectYamlConfig } from "./workspace";

/**
 * One DuckDB-resident object that should have a matching directory and
 * `.object.yaml` on disk. We accept a loose target shape because callers
 * (the tree GET handler) read these rows from old and new DuckDB schemas
 * and may not have every column populated.
 */
export type ProjectionTarget = {
  name: string;
  id?: string | null;
  description?: string | null;
  default_view?: string | null;
  icon?: string | null;
};

export type ProjectionStatus = "created" | "yaml_added" | "skipped" | "error";

export type ProjectionResult = {
  name: string;
  status: ProjectionStatus;
  reason?: string;
};

const PROJECTION_SCAN_SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
]);

function objectYamlMatchesName(yamlPath: string, objectName: string): boolean {
  try {
    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = YAML.parse(raw) as { name?: unknown } | null;
    return parsed?.name === objectName;
  } catch {
    return false;
  }
}

function hasExistingObjectYamlOutsideRootSlot(
  workspaceRoot: string,
  objectName: string,
  rootObjectDir: string,
): boolean {
  const resolvedRootObjectDir = resolve(rootObjectDir);

  function walk(dir: string): boolean {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    const yamlPath = join(dir, ".object.yaml");
    if (
      resolve(dir) !== resolvedRootObjectDir &&
      existsSync(yamlPath) &&
      objectYamlMatchesName(yamlPath, objectName)
    ) {
      return true;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || PROJECTION_SCAN_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      if (walk(join(dir, entry.name))) {
        return true;
      }
    }

    return false;
  }

  return walk(workspaceRoot);
}

/**
 * Project a single DuckDB object onto the filesystem. Idempotent:
 * - if the directory and `.object.yaml` already exist, returns "skipped"
 * - if the directory exists but the YAML is missing, writes the YAML
 *   ("yaml_added")
 * - if neither exists, creates both ("created")
 *
 * Refuses to write outside `workspaceRoot`, follows the same path-safety
 * checks as `POST /api/workspace/objects`.
 *
 * Why this exists: agents (and the legacy `ensureNewObject` migration
 * helper) frequently insert rows into `objects` without ever creating the
 * matching directory or YAML. The tree builder is filesystem-centric, so
 * such rows become invisible until something heals them. This function is
 * the heal step.
 */
export function projectObjectToFilesystem(
  workspaceRoot: string,
  target: ProjectionTarget,
): ProjectionResult {
  const name = target.name;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    return { name, status: "skipped", reason: "invalid_name" };
  }

  const resolvedRoot = resolve(workspaceRoot);
  const objectDir = resolve(join(resolvedRoot, name));
  if (!objectDir.startsWith(resolvedRoot + "/") && objectDir !== resolvedRoot) {
    return { name, status: "skipped", reason: "outside_workspace" };
  }

  const yamlPath = join(objectDir, ".object.yaml");
  if (
    !existsSync(yamlPath) &&
    hasExistingObjectYamlOutsideRootSlot(resolvedRoot, name, objectDir)
  ) {
    return { name, status: "skipped", reason: "object_exists_nested" };
  }

  let createdDir = false;
  if (existsSync(objectDir)) {
    let isDir = false;
    try {
      isDir = statSync(objectDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      // Something non-directory (file/symlink) is squatting the slot we'd
      // need. Don't touch it — that's a real conflict the user should fix.
      return { name, status: "skipped", reason: "non_directory_at_path" };
    }
  } else {
    try {
      mkdirSync(objectDir, { recursive: false });
      createdDir = true;
    } catch (err) {
      return {
        name,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (existsSync(yamlPath)) {
    if (createdDir) {
      // We just created the directory but somehow the yaml exists — odd
      // but harmless; treat as success.
      return { name, status: "created" };
    }
    return { name, status: "skipped", reason: "yaml_exists" };
  }

  const config: ObjectYamlConfig = {};
  if (target.id) {config.id = target.id;}
  config.name = name;
  if (target.description) {config.description = target.description;}
  if (target.icon) {config.icon = target.icon;}
  config.default_view = target.default_view ?? "table";
  config.entry_count = 0;
  config.fields = [];

  try {
    const yaml = YAML.stringify(config, { indent: 2, lineWidth: 0 });
    writeFileSync(yamlPath, yaml, "utf-8");
  } catch (err) {
    return {
      name,
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return { name, status: createdDir ? "created" : "yaml_added" };
}

/**
 * Project every supplied target. Errors on individual targets are
 * captured per-result and never throw — the caller (tree GET) must
 * stay responsive even when one object can't be healed.
 */
export function projectMissingObjectsToFilesystem(
  workspaceRoot: string,
  targets: Iterable<ProjectionTarget>,
): ProjectionResult[] {
  const results: ProjectionResult[] = [];
  for (const target of targets) {
    try {
      results.push(projectObjectToFilesystem(workspaceRoot, target));
    } catch (err) {
      results.push({
        name: target.name,
        status: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
