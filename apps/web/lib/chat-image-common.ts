export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image

const ATTACHED_FILES_PREFIX = "[Attached files: ";

export const CHAT_IMAGE_EXTENSION_TO_MIME = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".heic": "image/heic",
	".tiff": "image/tiff",
} as const;

export const CHAT_IMAGE_EXTENSIONS = new Set(
	Object.keys(CHAT_IMAGE_EXTENSION_TO_MIME),
);

export const CHAT_BROWSER_SAFE_IMAGE_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/bmp",
]);

export const CHAT_BROWSER_SAFE_IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".bmp",
]);

export function extractAttachedFilePaths(text: string): string[] {
	const start = text.indexOf(ATTACHED_FILES_PREFIX);
	if (start === -1) {return [];}
	const contentStart = start + ATTACHED_FILES_PREFIX.length;
	const end = text.indexOf("]", contentStart);
	if (end === -1) {return [];}
	return text.slice(contentStart, end)
		.split(", ")
		.map((path) => path.trim())
		.filter(Boolean);
}
