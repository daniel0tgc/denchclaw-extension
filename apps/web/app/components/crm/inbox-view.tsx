/**
 * Back-compat re-export. The real implementation lives in
 * `./inbox/inbox-view.tsx`. workspace-content.tsx already imports
 * `InboxView` from this path, so we keep this shim to avoid touching
 * the workspace orchestrator unnecessarily.
 */
export { InboxView } from "./inbox/inbox-view";
