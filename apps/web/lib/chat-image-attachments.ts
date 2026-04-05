import { basename, extname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { ImageAttachment } from "@/lib/agent-runner";
import { resolveWorkspaceRoot } from "@/lib/workspace";
import {
	CHAT_IMAGE_EXTENSION_TO_MIME,
	CHAT_IMAGE_EXTENSIONS,
	extractAttachedFilePaths,
	MAX_CHAT_IMAGE_BYTES,
} from "@/lib/chat-image-common";

export type ChatImageHydrationSkipReason =
	| "missing-workspace-root"
	| "missing-file"
	| "too-large"
	| "unreadable-file";

export type ChatImageHydrationSkip = {
	path: string;
	reason: ChatImageHydrationSkipReason;
};

export type ChatImageHydrationResult = {
	attachmentPaths: string[];
	imagePaths: string[];
	attachments: ImageAttachment[];
	skipped: ChatImageHydrationSkip[];
};

function resolveAttachmentAbsolutePath(
	filePath: string,
	workspaceRoot: string | null,
): string | null {
	if (filePath.startsWith("/")) {return filePath;}
	if (!workspaceRoot) {return null;}
	return join(workspaceRoot, filePath);
}

export function hydrateMessageImageAttachments(
	text: string,
	workspaceRoot = resolveWorkspaceRoot(),
): ChatImageHydrationResult {
	const attachmentPaths = extractAttachedFilePaths(text);
	const imagePaths = attachmentPaths.filter((filePath) =>
		CHAT_IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase()),
	);
	const attachments: ImageAttachment[] = [];
	const skipped: ChatImageHydrationSkip[] = [];

	for (const filePath of imagePaths) {
		const ext = extname(filePath).toLowerCase() as keyof typeof CHAT_IMAGE_EXTENSION_TO_MIME;
		const absPath = resolveAttachmentAbsolutePath(filePath, workspaceRoot);
		if (!absPath) {
			skipped.push({ path: filePath, reason: "missing-workspace-root" });
			continue;
		}
		if (!existsSync(absPath)) {
			skipped.push({ path: filePath, reason: "missing-file" });
			continue;
		}
		try {
			const data = readFileSync(absPath);
			if (data.length > MAX_CHAT_IMAGE_BYTES) {
				skipped.push({ path: filePath, reason: "too-large" });
				continue;
			}
			attachments.push({
				content: data.toString("base64"),
				mimeType: CHAT_IMAGE_EXTENSION_TO_MIME[ext] ?? "application/octet-stream",
				fileName: basename(filePath),
			});
		} catch {
			skipped.push({ path: filePath, reason: "unreadable-file" });
		}
	}

	return {
		attachmentPaths,
		imagePaths,
		attachments,
		skipped,
	};
}

export function buildChatImageHydrationErrorMessage(
	skipped: ChatImageHydrationSkip[],
): string | null {
	if (skipped.length === 0) {return null;}
	const first = skipped[0];
	const fileLabel = basename(first.path);
	switch (first.reason) {
		case "missing-workspace-root":
		case "missing-file":
			return `Couldn't attach image \`${fileLabel}\` for vision because the file is no longer available. Please re-upload it.`;
		case "too-large":
			return `Couldn't attach image \`${fileLabel}\` for vision because it exceeds the 5 MB limit. Please choose a smaller image.`;
		case "unreadable-file":
			return `Couldn't attach image \`${fileLabel}\` for vision. Please re-save it as PNG or JPEG and try again.`;
		default:
			return "Couldn't attach one of your images for vision.";
	}
}
