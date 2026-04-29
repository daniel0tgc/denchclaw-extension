import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  projectMissingObjectsToFilesystem,
  projectObjectToFilesystem,
} from "./workspace-projection";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "ws-projection-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("projectObjectToFilesystem", () => {
  it("creates directory and .object.yaml when neither exist", () => {
    const result = projectObjectToFilesystem(tempRoot, {
      name: "tasks",
      id: "id-1",
      description: "Outstanding work",
      default_view: "kanban",
      icon: "list",
    });

    expect(result).toEqual({ name: "tasks", status: "created" });
    const dir = join(tempRoot, "tasks");
    const yamlPath = join(dir, ".object.yaml");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(yamlPath)).toBe(true);

    const parsed = YAML.parse(readFileSync(yamlPath, "utf-8"));
    expect(parsed).toMatchObject({
      id: "id-1",
      name: "tasks",
      description: "Outstanding work",
      icon: "list",
      default_view: "kanban",
      entry_count: 0,
      fields: [],
    });
  });

  it("regression: a DB row with no matching directory or YAML becomes visible after projection", () => {
    // Reproduces user-reported bug: workspace.duckdb has the object,
    // but the filesystem doesn't. Tree builder is FS-centric so the
    // object is invisible until something projects it back to disk.
    const result = projectObjectToFilesystem(tempRoot, { name: "systumm" });
    expect(result.status).toBe("created");
    expect(existsSync(join(tempRoot, "systumm", ".object.yaml"))).toBe(true);
  });

  it("writes only the .object.yaml when the directory already exists", () => {
    mkdirSync(join(tempRoot, "people"));
    const result = projectObjectToFilesystem(tempRoot, {
      name: "people",
      id: "id-2",
    });
    expect(result).toEqual({ name: "people", status: "yaml_added" });
    expect(existsSync(join(tempRoot, "people", ".object.yaml"))).toBe(true);
  });

  it("is idempotent: running twice when both exist returns skipped", () => {
    projectObjectToFilesystem(tempRoot, { name: "deals", id: "id-3" });
    const second = projectObjectToFilesystem(tempRoot, { name: "deals", id: "id-3" });
    expect(second).toEqual({ name: "deals", status: "skipped", reason: "yaml_exists" });
  });

  it("does NOT overwrite an existing .object.yaml", () => {
    const dir = join(tempRoot, "company");
    mkdirSync(dir);
    const yamlPath = join(dir, ".object.yaml");
    writeFileSync(yamlPath, "icon: building\nname: company\n", "utf-8");

    const result = projectObjectToFilesystem(tempRoot, {
      name: "company",
      icon: "DIFFERENT-ICON",
    });
    expect(result.status).toBe("skipped");
    const parsed = YAML.parse(readFileSync(yamlPath, "utf-8"));
    expect(parsed.icon).toBe("building");
  });

  it("rejects names with shell-unsafe characters", () => {
    const result = projectObjectToFilesystem(tempRoot, { name: "../escape" });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("invalid_name");
  });

  it("skips when a non-directory file already squats the slot", () => {
    const slot = join(tempRoot, "blob");
    writeFileSync(slot, "not a directory");
    const result = projectObjectToFilesystem(tempRoot, { name: "blob" });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("non_directory_at_path");
    expect(readFileSync(slot, "utf-8")).toBe("not a directory");
  });

  it("falls back to default_view='table' when none provided", () => {
    projectObjectToFilesystem(tempRoot, { name: "notes" });
    const parsed = YAML.parse(readFileSync(join(tempRoot, "notes", ".object.yaml"), "utf-8"));
    expect(parsed.default_view).toBe("table");
  });
});

describe("projectMissingObjectsToFilesystem", () => {
  it("projects every supplied target and reports per-row results", () => {
    const results = projectMissingObjectsToFilesystem(tempRoot, [
      { name: "tasks", id: "id-1" },
      { name: "deals", id: "id-2" },
      { name: "../escape" },
    ]);
    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe("created");
    expect(results[1]?.status).toBe("created");
    expect(results[2]?.status).toBe("skipped");
    expect(existsSync(join(tempRoot, "tasks", ".object.yaml"))).toBe(true);
    expect(existsSync(join(tempRoot, "deals", ".object.yaml"))).toBe(true);
  });

  it("does not throw when one target errors mid-iteration", () => {
    // Pre-create a file that blocks "blob" while "tasks" is fine.
    writeFileSync(join(tempRoot, "blob"), "x");
    const results = projectMissingObjectsToFilesystem(tempRoot, [
      { name: "tasks" },
      { name: "blob" },
    ]);
    expect(results.find((r) => r.name === "tasks")?.status).toBe("created");
    expect(results.find((r) => r.name === "blob")?.status).toBe("skipped");
  });
});
