import type { FileInfo, FileType } from './types';

const VIDEO_MIMES = new Set([
	'video/mp4',
	'video/webm',
	'video/ogg',
	'video/quicktime',
	'video/x-msvideo',
	'video/x-matroska'
]);

const IMAGE_MIMES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/avif',
	'image/gif',
	'image/tiff',
	'image/bmp',
	'image/svg+xml'
]);

/**
 * Detect whether a file is an image, video, or other.
 */
export function getFileType(file: File): FileType {
	const mime = file.type.toLowerCase();
	if (VIDEO_MIMES.has(mime)) return 'video';
	if (IMAGE_MIMES.has(mime)) return 'image';
	// Fall back to extension check
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	if (['mp4', 'webm', 'avi', 'mov', 'mkv', 'ogv'].includes(ext)) return 'video';
	if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'tif'].includes(ext))
		return 'image';
	return 'other';
}

/**
 * Format bytes into a human-readable string (KB, MB).
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Derive a FileInfo from a raw File object.
 */
export function deriveFileInfo(file: File): FileInfo {
	return {
		name: file.name,
		size: file.size,
		type: getFileType(file),
		mime: file.type
	};
}

/**
 * Check if the browser supports required WASM features.
 */
export function supportsWasm(): boolean {
	return typeof WebAssembly !== 'undefined' && typeof WebAssembly.instantiate === 'function';
}

export interface NativeVideoMeta {
	duration: number;
	width: number;
	height: number;
}

/**
 * Probe a video's duration and resolution using the browser's native
 * media stack. Only metadata is streamed from disk — the file is NOT
 * copied into memory — so this works even for files far too large for
 * the WASM virtual filesystem. Returns null for containers the browser
 * can't parse natively (mkv, avi, …) or on timeout.
 */
export function probeVideoMetadata(
	file: File,
	timeoutMs = 10_000
): Promise<NativeVideoMeta | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const video = document.createElement('video');
		let settled = false;

		const timer = setTimeout(() => finish(null), timeoutMs);

		function finish(result: NativeVideoMeta | null): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			video.removeAttribute('src');
			video.load(); // release the media resource
			URL.revokeObjectURL(url);
			resolve(result);
		}

		video.preload = 'metadata';
		video.onloadedmetadata = () => {
			const { duration, videoWidth, videoHeight } = video;
			// duration can be Infinity for some containers — treat as unknown
			if (isFinite(duration) && videoWidth > 0) {
				finish({ duration, width: videoWidth, height: videoHeight });
			} else {
				finish(null);
			}
		};
		video.onerror = () => finish(null);
		video.src = url;
	});
}
