import {
	CHAT_BROWSER_SAFE_IMAGE_EXTENSIONS,
	CHAT_BROWSER_SAFE_IMAGE_MIME_TYPES,
	MAX_CHAT_IMAGE_BYTES,
} from "@/lib/chat-image-common";

const IMAGE_LIKE_EXTENSIONS = new Set([
	...CHAT_BROWSER_SAFE_IMAGE_EXTENSIONS,
	".svg",
	".ico",
	".heic",
	".heif",
	".tif",
	".tiff",
	".avif",
]);

type LoadedImage = {
	width: number;
	height: number;
	render: (
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
	) => void;
	cleanup: () => void;
};

export type ChatImagePreparationTools = {
	loadImage?: (file: File) => Promise<LoadedImage>;
	createCanvas?: (width: number, height: number) => HTMLCanvasElement;
	canvasToBlob?: (
		canvas: HTMLCanvasElement,
		type: string,
		quality?: number,
	) => Promise<Blob | null>;
};

function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function replaceExtension(name: string, nextExt: string): string {
	const dot = name.lastIndexOf(".");
	if (dot < 0) {return `${name}${nextExt}`;}
	return `${name.slice(0, dot)}${nextExt}`;
}

function isImageFile(file: File): boolean {
	return file.type.startsWith("image/") || IMAGE_LIKE_EXTENSIONS.has(fileExtension(file.name));
}

function canUseOriginalImage(file: File): boolean {
	return file.size <= MAX_CHAT_IMAGE_BYTES && (
		CHAT_BROWSER_SAFE_IMAGE_MIME_TYPES.has(file.type) ||
		(file.type.length === 0 && CHAT_BROWSER_SAFE_IMAGE_EXTENSIONS.has(fileExtension(file.name)))
	);
}

async function defaultLoadImage(file: File): Promise<LoadedImage> {
	if (typeof createImageBitmap === "function") {
		const bitmap = await createImageBitmap(file);
		return {
			width: bitmap.width,
			height: bitmap.height,
			render: (context, width, height) => {
				context.drawImage(bitmap, 0, 0, width, height);
			},
			cleanup: () => bitmap.close(),
		};
	}
	if (typeof document === "undefined") {
		throw new Error("Image conversion is unavailable in this environment.");
	}
	const url = URL.createObjectURL(file);
	try {
		const image = await new Promise<HTMLImageElement>((resolve, reject) => {
			const element = new Image();
			element.onload = () => resolve(element);
			element.onerror = () => reject(new Error("The image could not be decoded."));
			element.src = url;
		});
		return {
			width: image.naturalWidth || image.width,
			height: image.naturalHeight || image.height,
			render: (context, width, height) => {
				context.drawImage(image, 0, 0, width, height);
			},
			cleanup: () => URL.revokeObjectURL(url),
		};
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
	if (typeof document === "undefined") {
		throw new Error("Canvas is unavailable in this environment.");
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function defaultCanvasToBlob(
	canvas: HTMLCanvasElement,
	type: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob), type, quality);
	});
}

function preferredOutputTypes(file: File): string[] {
	const ext = fileExtension(file.name);
	if (ext === ".png" || ext === ".svg" || ext === ".ico") {
		return ["image/png", "image/jpeg"];
	}
	return ["image/jpeg", "image/png"];
}

function outputNameForType(name: string, type: string): string {
	return replaceExtension(name, type === "image/png" ? ".png" : ".jpg");
}

function fileFromBlob(blob: Blob, name: string, type: string): File {
	return new File([blob], name, {
		type,
		lastModified: Date.now(),
	});
}

function buildPreparationErrorMessage(fileName: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : "The image could not be processed.";
	return `${fileName}: ${detail}`;
}

export async function prepareImageFileForChatUpload(
	file: File,
	tools: ChatImagePreparationTools = {},
): Promise<File> {
	if (!isImageFile(file) || canUseOriginalImage(file)) {
		return file;
	}

	const loadImage = tools.loadImage ?? defaultLoadImage;
	const createCanvas = tools.createCanvas ?? defaultCreateCanvas;
	const canvasToBlob = tools.canvasToBlob ?? defaultCanvasToBlob;
	const scales = [1, 0.85, 0.7, 0.55, 0.4, 0.28, 0.18];
	const qualities = [0.9, 0.8, 0.7, 0.58, 0.46];
	const image = await loadImage(file);

	try {
		const sourceWidth = Math.max(1, image.width);
		const sourceHeight = Math.max(1, image.height);

		for (const outputType of preferredOutputTypes(file)) {
			for (const scale of scales) {
				const width = Math.max(1, Math.round(sourceWidth * scale));
				const height = Math.max(1, Math.round(sourceHeight * scale));
				const canvas = createCanvas(width, height);
				const context = canvas.getContext("2d");
				if (!context) {
					throw new Error("Canvas rendering is unavailable.");
				}
				if (outputType === "image/jpeg") {
					context.fillStyle = "#ffffff";
					context.fillRect(0, 0, width, height);
				}
				image.render(context, width, height);

				const candidateQualities = outputType === "image/png"
					? [undefined]
					: qualities;
				for (const quality of candidateQualities) {
					const blob = await canvasToBlob(canvas, outputType, quality);
					if (!blob) {continue;}
					if (blob.size <= MAX_CHAT_IMAGE_BYTES) {
						return fileFromBlob(
							blob,
							outputNameForType(file.name, outputType),
							outputType,
						);
					}
				}
			}
		}
	} finally {
		image.cleanup();
	}

	throw new Error("Please choose a smaller PNG or JPEG under 5 MB.");
}

export async function prepareFilesForChatUpload(
	files: FileList | File[],
	tools: ChatImagePreparationTools = {},
): Promise<{ files: File[]; errors: string[] }> {
	const preparedFiles: File[] = [];
	const errors: string[] = [];

	for (const file of Array.from(files)) {
		try {
			preparedFiles.push(await prepareImageFileForChatUpload(file, tools));
		} catch (error) {
			errors.push(buildPreparationErrorMessage(file.name, error));
		}
	}

	return { files: preparedFiles, errors };
}
