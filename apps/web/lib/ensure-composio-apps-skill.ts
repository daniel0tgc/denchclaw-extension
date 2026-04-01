import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDenchPackageRoot } from "@/lib/project-root";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { discoverWorkspaceDirs, MANAGED_SKILLS, seedSkill } from "@/lib/workspace-seed";

const composioAppsEntry = MANAGED_SKILLS.find((s) => s.name === "composio-apps");

/**
 * Copy `skills/composio-apps` from the shipped package into each configured
 * workspace when missing (upgrades / dev installs without re-running CLI sync).
 */
export function ensureComposioAppsSkillInWorkspaces(): void {
  if (!composioAppsEntry) {
    return;
  }
  const packageRoot = resolveDenchPackageRoot();
  if (!packageRoot) {
    return;
  }
  const stateDir = resolveOpenClawStateDir();
  for (const workspaceDir of discoverWorkspaceDirs(stateDir)) {
    const skillFile = join(workspaceDir, "skills", "composio-apps", "SKILL.md");
    if (!existsSync(skillFile)) {
      seedSkill({ workspaceDir, packageRoot }, composioAppsEntry);
    }
  }
}
