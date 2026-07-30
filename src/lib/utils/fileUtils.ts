import type { FileInfo, FileType } from './types';

const VIDEO_MIMES = new Set([
	'video/mp4',
	'video/webm',
	'video/ogg',
	'video/quicktime',
	'video/x-msvideo',
	'video/x-matroska'
]);

const AUDIO_MIMES = new Set([
	'audio/mpeg',
	'audio/wav',
	'audio/x-wav',
	'audio/wave',
	'audio/ogg',
	'audio/flac',
	'audio/x-flac',
	'audio/mp4',
	'audio/x-m4a',
	'audio/aac',
	'audio/x-aac',
	'audio/opus',
	'audio/webm',
	'audio/x-ms-wma',
	'audio/3gpp',
	'audio/3gpp2'
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
	if (AUDIO_MIMES.has(mime)) return 'audio';
	// Fall back to extension check
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	if (['mp4', 'webm', 'avi', 'mov', 'mkv', 'ogv'].includes(ext)) return 'video';
	if (['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'tif'].includes(ext))
		return 'image';
	if (['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'aac', 'opus', 'wma'].includes(ext))
		return 'audio';
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

export interface NativeMediaMeta {
	duration: number;
	width: number;
	height: number;
}

/**
 * Probe a media file's duration (and resolution, for video) using the
 * browser's native media stack. Only metadata is streamed from disk —
 * the file is NOT copied into memory — so this works even for files far
 * too large for the WASM virtual filesystem. Returns null for containers
 * the browser can't parse natively (mkv, avi, …) or on timeout.
 */
export function probeMediaMetadata(
	file: File,
	timeoutMs = 10_000
): Promise<NativeMediaMeta | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const media = document.createElement(
			file.type.startsWith('audio/') ? 'audio' : 'video'
		) as HTMLVideoElement;
		let settled = false;

		const timer = setTimeout(() => finish(null), timeoutMs);

		function finish(result: NativeMediaMeta | null): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			media.removeAttribute('src');
			media.load(); // release the media resource
			URL.revokeObjectURL(url);
			resolve(result);
		}

		media.preload = 'metadata';
		media.onloadedmetadata = () => {
			const { duration } = media;
			// duration can be Infinity for some containers — treat as unknown
			if (isFinite(duration) && duration > 0) {
				finish({
					duration,
					width: media.videoWidth || 0, // 0 for audio-only files
					height: media.videoHeight || 0
				});
			} else {
				finish(null);
			}
		};
		media.onerror = () => finish(null);
		media.src = url;
	});
}
