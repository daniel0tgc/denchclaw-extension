import {
	formatTableSelectionContext,
	type TableSelectionContext,
} from "@/lib/table-selection";

/**
 * Workspace context attached to a chat message in addition to the user's
 * typed text. The client sends this as a separate body field on POST /api/chat
 * so the persisted user message stays clean (no `[Context: ...]` /
 * `[Attached files: ...]` / `[Selected table ...]` prefixes baked in), while
 * the agent still receives the full prefixed prompt it expects.
 *
 * Each field is optional — clients only include a piece when it should
 * actually be announced to the agent on this turn (e.g. `filePath` is
 * omitted on subsequent turns once the path was already announced).
 */
export type WorkspaceContext = {
	/** Path of the active workspace file/directory the user is viewing. */
	filePath?: string;
	/** True when `filePath` is a directory or virtual surface (~crm/...). */
	isDirectory?: boolean;
	/** Paths of files mentioned in the editor or attached as uploads. */
	attachedFilePaths?: string[];
	/** Snapshot of selected table rows/cells, formatted into prompt text. */
	tableSelection?: TableSelectionContext;
};

/**
 * Build the prompt the agent actually sees, by prepending the same
 * bracketed metadata blocks the client used to assemble inline. Order
 * matches the legacy client implementation so behavior is identical from
 * the agent's perspective.
 */
export function buildAgentMessage(args: {
	userText: string;
	workspaceContext?: WorkspaceContext;
	/** Optional workspace-root prefix (e.g. /home/ubuntu/.openclaw/work). */
	workspacePrefix?: string | null;
}): string {
	const { userText, workspaceContext, workspacePrefix } = args;
	let message = userText;

	const ctx = workspaceContext;
	if (!ctx) {
		return message;
	}

	const attached = ctx.attachedFilePaths?.filter(Boolean) ?? [];
	if (attached.length > 0) {
		const attachedPrefix = `[Attached files: ${attached.join(", ")}]`;
		message = message ? `${attachedPrefix}\n\n${message}` : attachedPrefix;
	}

	if (ctx.filePath) {
		const label = ctx.isDirectory ? "directory" : "file";
		const fullPath = workspacePrefix
			? `${workspacePrefix}/${ctx.filePath}`
			: ctx.filePath;
		message = `[Context: workspace ${label} '${fullPath}']\n\n${message}`;
	}

	if (ctx.tableSelection) {
		message = `${formatTableSelectionContext(ctx.tableSelection)}\n\n${message}`;
	}

	return message;
}
