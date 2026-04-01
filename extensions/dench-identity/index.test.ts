import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import { buildIdentityPrompt, resolveWorkspaceDir } from "./index.ts";
import register from "./index.ts";
import path from "node:path";

describe("buildIdentityPrompt", () => {
  const workspaceDir = "/home/user/workspace";

  it("includes chat history path so agent can reference past conversations", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(".openclaw/web-chat/");
    expect(prompt).toContain(
      path.join(workspaceDir, ".openclaw/web-chat/"),
    );
  });

  it("includes all workspace context paths (prevents agent losing orientation)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(`**Root**: \`${workspaceDir}\``);
    expect(prompt).toContain(path.join(workspaceDir, "workspace.duckdb"));
    expect(prompt).toContain(path.join(workspaceDir, "skills"));
    expect(prompt).toContain(path.join(workspaceDir, "apps"));
  });

  it("includes CRM skill path for delegation (prevents agent using wrong skill path)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(
      path.join(workspaceDir, "skills", "crm", "SKILL.md"),
    );
  });

  it("includes composio-apps skill path and MCP tool preference", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain(
      path.join(workspaceDir, "skills", "composio-apps", "SKILL.md"),
    );
    expect(prompt).toContain("Composio MCP");
    expect(prompt).toContain("Never** use curl");
  });

  it("includes exec approval policy (prevents agent stalling on exec confirmation)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("elevated: true");
    expect(prompt).toContain("automatically approved");
  });

  it("references DenchClaw branding, not OpenClaw (prevents identity confusion)", () => {
    const prompt = buildIdentityPrompt(workspaceDir);
    expect(prompt).toContain("You are **DenchClaw**");
    expect(prompt).toContain("always use **DenchClaw** (not OpenClaw)");
  });
});

describe("buildIdentityPrompt composio-tool-index", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes Gmail tool names from composio-tool-index.json so the agent skips catalog discovery", () => {
    tmp = path.join(
      os.tmpdir(),
      `dench-identity-composio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, "composio-tool-index.json"),
      JSON.stringify({
        generated_at: "2026-04-01T00:00:00.000Z",
        connected_apps: [
          {
            toolkit_slug: "gmail",
            toolkit_name: "Gmail",
            account_count: 1,
            tools: [
              {
                name: "GMAIL_FETCH_EMAILS",
                title: "Fetch emails",
                description_short: "List inbox messages.",
                required_args: [],
                arg_hints: {
                  label_ids: 'Use ["INBOX"] as JSON array.',
                },
              },
            ],
            recipes: { "Read recent emails": "GMAIL_FETCH_EMAILS" },
          },
        ],
      }),
      "utf-8",
    );

    const prompt = buildIdentityPrompt(tmp);
    expect(prompt).toContain("Connected App Tools (via Composio MCP)");
    expect(prompt).toContain("GMAIL_FETCH_EMAILS");
    expect(prompt).toContain("Read recent emails");
    expect(prompt).toContain("label_ids");
  });
});

describe("resolveWorkspaceDir", () => {
  it("returns workspace path when config is a valid string", () => {
    const api = { config: { agents: { defaults: { workspace: "/home/user/ws" } } } };
    expect(resolveWorkspaceDir(api)).toBe("/home/user/ws");
  });

  it("returns undefined when api is null (prevents crash on missing config)", () => {
    expect(resolveWorkspaceDir(null)).toBeUndefined();
  });

  it("returns undefined when api is undefined (prevents crash on missing config)", () => {
    expect(resolveWorkspaceDir(undefined)).toBeUndefined();
  });

  it("returns undefined when config chain is missing (prevents crash on partial config)", () => {
    expect(resolveWorkspaceDir({})).toBeUndefined();
    expect(resolveWorkspaceDir({ config: {} })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: {} } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: {} } } })).toBeUndefined();
  });

  it("returns undefined when workspace is empty string (prevents empty path injection)", () => {
    const api = { config: { agents: { defaults: { workspace: "" } } } };
    expect(resolveWorkspaceDir(api)).toBeUndefined();
  });

  it("returns undefined when workspace is whitespace-only (prevents whitespace path injection)", () => {
    const api = { config: { agents: { defaults: { workspace: "   " } } } };
    expect(resolveWorkspaceDir(api)).toBeUndefined();
  });

  it("returns undefined when workspace is not a string (prevents type coercion)", () => {
    expect(resolveWorkspaceDir({ config: { agents: { defaults: { workspace: 42 } } } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: { workspace: true } } } })).toBeUndefined();
    expect(resolveWorkspaceDir({ config: { agents: { defaults: { workspace: null } } } })).toBeUndefined();
  });

  it("trims leading/trailing whitespace from valid paths", () => {
    const api = { config: { agents: { defaults: { workspace: "  /home/user/ws  " } } } };
    expect(resolveWorkspaceDir(api)).toBe("/home/user/ws");
  });
});

describe("register", () => {
  it("hooks into before_prompt_build event when enabled", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: "/ws" } } },
      on: vi.fn(),
    };
    register(api);
    expect(api.on).toHaveBeenCalledWith(
      "before_prompt_build",
      expect.any(Function),
      { priority: 100 },
    );
  });

  it("does not register handler when plugin is explicitly disabled (respects config)", () => {
    const api = {
      config: { plugins: { entries: { "dench-identity": { config: { enabled: false } } } } },
      on: vi.fn(),
    };
    register(api);
    expect(api.on).not.toHaveBeenCalled();
  });

  it("handler returns system context when workspace is configured", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: { workspace: "/ws" } } },
      on: vi.fn(),
    };
    register(api);

    const handler = api.on.mock.calls[0][1];
    const result = handler({}, {});
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("DenchClaw"),
    });
  });

  it("handler returns undefined when workspace is not configured (prevents empty prompt)", () => {
    const api = {
      config: { plugins: { entries: {} }, agents: { defaults: {} } },
      on: vi.fn(),
    };
    register(api);

    const handler = api.on.mock.calls[0][1];
    const result = handler({}, {});
    expect(result).toBeUndefined();
  });
});
