export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTerminalServer } = await import("./lib/terminal-server");
    startTerminalServer(Number(process.env.TERMINAL_WS_PORT) || 3101);

    const { startChatAgentGc } = await import("./lib/chat-agent-registry");
    startChatAgentGc();

    // Apply the latest schema migrations on startup so workspaces that
    // were init'd before a column/field/object was added still get it
    // without forcing the user to re-init. Idempotent: ALTER TABLE … IF
    // NOT EXISTS, INSERT … OR IGNORE etc. inside `ensureLatestSchema`.
    // Without this, hidden_in_sidebar (and Sender Type, etc.) wouldn't
    // exist on the DB until the user manually triggered onboarding.
    try {
      const { ensureLatestSchema } = await import("./lib/workspace-schema-migrations");
      await ensureLatestSchema();
    } catch (err) {
      // Non-fatal — the workspace runs fine without the new fields, the
      // user just won't see CRM-only objects hidden from the tree until
      // the migration is re-attempted.
      console.error("[instrumentation] ensureLatestSchema failed:", err);
    }

    // Resume the Gmail/Calendar incremental poll loop after process restart
    // if the user has already completed onboarding. Cursors persisted in
    // .denchclaw/sync-cursors.json mean no message is lost across restarts.
    try {
      const { isOnboardingComplete, readConnections, readSyncCursors } = await import(
        "./lib/denchclaw-state"
      );
      if (isOnboardingComplete()) {
        const connections = readConnections();
        const cursors = readSyncCursors();
        const hasGmailWatch = connections.gmail && cursors.gmail?.historyId;
        const hasCalendarWatch = connections.calendar && cursors.calendar?.syncToken;
        if (hasGmailWatch || hasCalendarWatch) {
          const { armIncrementalPoller } = await import("./lib/sync-runner");
          armIncrementalPoller();
        }
      }
    } catch {
      // Non-fatal — poller will be re-armed when the user completes a
      // manual sync from the workspace.
    }
  }
}
