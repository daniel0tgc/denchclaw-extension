import { describe, expect, it } from "vitest";
import { applyCliProfileEnv, parseCliProfileArgs, IRONCLAW_PROFILE } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("returns default profile parsing when no args are provided", () => {
    expect(parseCliProfileArgs(["node", "ironclaw"])).toEqual({
      ok: true,
      profile: null,
      argv: ["node", "ironclaw"],
    });
  });

  it("parses --profile and strips profile flags before command execution", () => {
    expect(parseCliProfileArgs(["node", "ironclaw", "--profile", "dev", "chat"])).toEqual({
      ok: true,
      profile: "dev",
      argv: ["node", "ironclaw", "chat"],
    });

    expect(parseCliProfileArgs(["node", "ironclaw", "--profile=team-a", "status"])).toEqual({
      ok: true,
      profile: "team-a",
      argv: ["node", "ironclaw", "status"],
    });
  });

  it("rejects missing and invalid profile inputs", () => {
    expect(parseCliProfileArgs(["node", "ironclaw", "--profile"])).toEqual({
      ok: false,
      error: "--profile requires a value",
    });

    expect(parseCliProfileArgs(["node", "ironclaw", "--profile", "bad profile"])).toEqual({
      ok: false,
      error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
    });
  });

  it("allows --dev and --profile together (Ironclaw forces ironclaw anyway)", () => {
    const result = parseCliProfileArgs(["node", "ironclaw", "--dev", "--profile", "team-a"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toBe("team-a");
    }
  });

  it("stops profile parsing once command path begins", () => {
    expect(parseCliProfileArgs(["node", "ironclaw", "chat", "--profile", "dev"])).toEqual({
      ok: true,
      profile: null,
      argv: ["node", "ironclaw", "chat", "--profile", "dev"],
    });
  });
});

describe("applyCliProfileEnv", () => {
  it("always forces ironclaw profile regardless of requested profile (single profile enforcement)", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyCliProfileEnv({
      profile: "team-a",
      env,
      homedir: () => "/tmp/home",
    });

    expect(result.effectiveProfile).toBe(IRONCLAW_PROFILE);
    expect(env.OPENCLAW_PROFILE).toBe(IRONCLAW_PROFILE);
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/home/.openclaw-ironclaw");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/tmp/home/.openclaw-ironclaw/openclaw.json");
  });

  it("emits warning when non-ironclaw profile is requested (prevents silent override)", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyCliProfileEnv({
      profile: "team-a",
      env,
      homedir: () => "/tmp/home",
    });

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("team-a");
    expect(result.warning).toContain(IRONCLAW_PROFILE);
    expect(result.requestedProfile).toBe("team-a");
  });

  it("no warning when ironclaw profile is requested (normal path)", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyCliProfileEnv({
      profile: IRONCLAW_PROFILE,
      env,
      homedir: () => "/tmp/home",
    });

    expect(result.warning).toBeUndefined();
    expect(result.effectiveProfile).toBe(IRONCLAW_PROFILE);
  });

  it("no warning when no profile is specified (default path)", () => {
    const env: Record<string, string | undefined> = {};
    const result = applyCliProfileEnv({
      env,
      homedir: () => "/tmp/home",
    });

    expect(result.warning).toBeUndefined();
    expect(result.effectiveProfile).toBe(IRONCLAW_PROFILE);
  });

  it("always overwrites OPENCLAW_STATE_DIR to pinned path (prevents state drift)", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_STATE_DIR: "/custom/state",
      OPENCLAW_CONFIG_PATH: "/custom/state/openclaw.json",
    };
    const result = applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/tmp/home",
    });

    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/home/.openclaw-ironclaw");
    expect(env.OPENCLAW_CONFIG_PATH).toBe("/tmp/home/.openclaw-ironclaw/openclaw.json");
    expect(result.stateDir).toBe("/tmp/home/.openclaw-ironclaw");
  });

  it("picks up OPENCLAW_PROFILE from env when no explicit profile is passed", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_PROFILE: "from-env",
    };
    const result = applyCliProfileEnv({
      env,
      homedir: () => "/tmp/home",
    });

    expect(result.requestedProfile).toBe("from-env");
    expect(result.effectiveProfile).toBe(IRONCLAW_PROFILE);
    expect(result.warning).toContain("from-env");
  });

  it("both root and bootstrap-local profile forms resolve to same state dir", () => {
    const rootEnv: Record<string, string | undefined> = {};
    const bootstrapLocalEnv: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "team-a",
      env: rootEnv,
      homedir: () => "/tmp/home",
    });
    applyCliProfileEnv({
      profile: "team-a",
      env: bootstrapLocalEnv,
      homedir: () => "/tmp/home",
    });

    expect(rootEnv.OPENCLAW_PROFILE).toBe(bootstrapLocalEnv.OPENCLAW_PROFILE);
    expect(rootEnv.OPENCLAW_STATE_DIR).toBe(bootstrapLocalEnv.OPENCLAW_STATE_DIR);
    expect(rootEnv.OPENCLAW_CONFIG_PATH).toBe(bootstrapLocalEnv.OPENCLAW_CONFIG_PATH);
  });
});
