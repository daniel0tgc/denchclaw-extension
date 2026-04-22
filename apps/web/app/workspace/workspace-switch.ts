type WorkspaceSwitchDeps = {
  setBrowseDir: (dir: string | null) => void;
  /**
   * Clear the active content tab so the right panel falls back to the
   * placeholder. The new tabs reducer drives `activePath`/`content` from
   * the active tab, so clearing the id is enough to wipe the panel.
   */
  clearActiveContent: () => void;
  setActiveSessionId: (sessionId: string | null) => void;
  setActiveSubagentKey: (sessionKey: string | null) => void;
  resetMainChat: () => void;
  replaceUrlToRoot: () => void;
  reconnectWorkspaceWatcher: () => void;
  refreshSessions: () => void;
  refreshContext: () => void;
};

/**
 * Keep workspace switching deterministic:
 * clear file/chat selection first, then force a fresh chat session so
 * subsequent messages cannot reuse the prior workspace's session key.
 */
export function resetWorkspaceStateOnSwitch(deps: WorkspaceSwitchDeps): void {
  deps.setBrowseDir(null);
  deps.clearActiveContent();
  deps.setActiveSessionId(null);
  deps.setActiveSubagentKey(null);
  deps.resetMainChat();
  deps.replaceUrlToRoot();
  deps.reconnectWorkspaceWatcher();
  deps.refreshSessions();
  deps.refreshContext();
}
