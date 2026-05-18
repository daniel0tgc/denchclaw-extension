#!/usr/bin/env node

// Load .env.local from the repo root so DENCH_API_KEY can be stored there
// instead of being typed on every invocation. Safe to ignore if missing.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
