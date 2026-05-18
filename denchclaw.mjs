#!/usr/bin/env node

// Load .env.local from the repo root so DENCH_API_KEY can be stored there
// instead of being typed on every invocation. Safe to ignore if missing.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
(function loadEnvLocal() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(dir, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // .env.local is optional
  }
})();

// Strip the Composio MCP server from openclaw.json before every start.
// dench-cloud/dench.instant has a 256k context window; loading hundreds of
// Composio tool schemas exhausts it and produces empty agent responses.
// The dench-ai-gateway extension strips this from memory at runtime but
// OpenClaw re-persists it to disk on config writes, so we must also strip
// it here on each startup before the gateway reads the config.
(function stripComposioMcp() {
  try {
    const configPath = join(homedir(), ".openclaw-dench", "openclaw.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const servers = config?.mcp?.servers;
    if (servers?.composio) {
      delete servers.composio;
      if (Object.keys(servers).length === 0) delete config.mcp.servers;
      if (!config.mcp || Object.keys(config.mcp).length === 0) delete config.mcp;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  } catch {
    // config may not exist yet on first run
  }
})();

import module from "node:module";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const installProcessWarningFilter = async () => {
  // Keep bootstrap warnings consistent with the TypeScript runtime.
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
};

await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    // Only swallow missing-module errors; rethrow real runtime errors.
    if (isModuleNotFoundError(err)) {
      return false;
    }
    throw err;
  }
};

if (await tryImport("./dist/entry.js")) {
  // OK
} else if (await tryImport("./dist/entry.mjs")) {
  // OK
} else {
  throw new Error("denchclaw: missing dist/entry.(m)js (build output).");
}
