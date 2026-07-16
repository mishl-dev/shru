import {
	initializeImageMagick,
	ImageMagick,
	MagickFormat,
	type IMagickImage
} from '@imagemagick/magick-wasm';
import type { CompressionProgress } from './types';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIMENSION = 4000;
const INITIAL_QUALITY = 85;
const MAX_QUALITY = 100;
const MIN_QUALITY = 1;

let wasmInitPromise: Promise<void> | null = null;

/**
 * Lazily initialize the ImageMagick WASM engine.
 * Fetches the wasm binary via the Vite-resolved URL.
 * Guards against concurrent initialization via a shared promise.
 */
async function ensureWasm(): Promise<void> {
	if (wasmInitPromise) return wasmInitPromise;
	console.log('[image] initializing ImageMagick WASM…');
	wasmInitPromise = (async () => {
		try {
			const wasmUrl = new URL(
				'@imagemagick/magick-wasm/magick.wasm',
				import.meta.url
			).href;
			const response = await fetch(wasmUrl);
			const wasmBytes = new Uint8Array(await response.arrayBuffer());
			await initializeImageMagick(wasmBytes);
			console.log('[image] ImageMagick WASM ready');
		} catch (err) {
			wasmInitPromise = null; // Allow next caller to retry
			console.error('[image] failed to initialize ImageMagick WASM:', err);
			throw new Error('Failed to load image compression engine. Please try again.');
		}
	})();
	return wasmInitPromise;
}

/**
 * Downscale an image if its longest side exceeds the given limit.
 * Mutates the image in place.
 */
function downscaleIfNeeded(image: IMagickImage, limit: number): void {
	const longest = Math.max(image.width, image.height);
	if (longest > limit) {
		console.log(`[image] downscaling from ${image.width}×${image.height} (longest ${longest}px → ${limit}px)`);
		if (image.width >= image.height) {
			image.resize(limit, 0);
		} else {
			image.resize(0, limit);
		}
		console.log(`[image] downscaled to ${image.width}×${image.height}`);
	}
}

/**
 * Pre-initialize the ImageMagick WASM engine.
 * Call early so it's ready when the user clicks compress.
 */
export async function initImageEngine(): Promise<void> {
	await ensureWasm();
}

/**
 * Compress an image file to under 10MB using ImageMagick WASM.
 */
export async function compressImage(
	file: File,
	onProgress?: (progress: CompressionProgress) => void
): Promise<Blob> {
	await ensureWasm();

	const inputBytes = new Uint8Array(await file.arrayBuffer());
	const inputSizeMB = (inputBytes.length / (1024 * 1024)).toFixed(2);
	console.log(`[image] compressing ${file.name} — ${(file.size / 1024).toFixed(1)} KB (${inputSizeMB} MB), type: ${file.type}`);

	await reportProgress(onProgress, 0, 'Reading image…');

	const initialResult = await ImageMagick.read(inputBytes, async (image: IMagickImage) => {
		console.log(`[image] dimensions: ${image.width}×${image.height}, format: ${image.format}`);

		await reportProgress(onProgress, 10, 'Stripping metadata…');
		image.strip();
		console.log('[image] metadata stripped');

		// Determine initial dimensions
		let currentWidth = image.width;
		let currentHeight = image.height;

		// Scale down if needed
		const longest = Math.max(currentWidth, currentHeight);
		if (longest > MAX_DIMENSION) {
			await reportProgress(onProgress, 20, `Downscaling from ${longest}px…`);
			downscaleIfNeeded(image, MAX_DIMENSION);
			currentWidth = image.width;
			currentHeight = image.height;
		}

		// Phase 2: Binary search on quality
		await reportProgress(onProgress, 30, 'Compressing image…');

		const resultData = await binarySearchQuality(image, currentWidth, currentHeight, onProgress, 0, 30);

		const resultSizeKB = (resultData.length / 1024).toFixed(1);
		console.log(`[image] compressed to ${resultSizeKB} KB (quality ${image.quality})`);

		await reportProgress(onProgress, 95, 'Finalizing…');
		return resultData;
	});

	await reportProgress(onProgress, 100, 'Done');
		// Copy out of WASM memory: ImageMagick may reuse the underlying buffer
		const result = new Blob([initialResult.slice(0)], { type: 'image/webp' });
	console.log(`[image] done — ${(initialResult.length / 1024).toFixed(1)} KB, saved ${Math.round((1 - initialResult.length / inputBytes.length) * 100)}%`);
	return result;
}

/**
 * Binary search for optimal quality, falling back to dimension reduction if needed.
 * Reports progress in the range [startPct, 80].
 */
async function binarySearchQuality(
	image: IMagickImage,
	baseWidth: number,
	baseHeight: number,
	onProgress?: (progress: CompressionProgress) => void,
	depth = 0,
	startPct = 30
): Promise<Uint8Array> {
	// Prevent infinite recursion
	if (depth > 5) {
		console.log(`[image] max depth reached, using minimum quality`);
		image.quality = MIN_QUALITY;
		return new Promise((resolve) => {
			image.write(MagickFormat.WebP, (data: Uint8Array) => resolve(new Uint8Array(data)));
		});
	}

	const range = 80 - startPct;

	// Try initial quality
	image.quality = INITIAL_QUALITY;
	console.log(`[image] trying initial quality ${INITIAL_QUALITY} at ${image.width}×${image.height}`);
	let bestData = await writeImage(image);
	console.log(`[image] quality ${INITIAL_QUALITY}: ${(bestData.length / 1024).toFixed(1)} KB ${bestData.length <= MAX_BYTES ? '✓ under limit' : '✗ over limit'}`);

		if (bestData.length <= MAX_BYTES) {
			// Try to increase quality for better result
			console.log('[image] under limit — refining quality upward');
			await reportProgress(onProgress, Math.round(startPct + range * 0.1), 'Refining quality…');
			return refineQuality(image, INITIAL_QUALITY, MAX_QUALITY, onProgress, startPct);
		}

	// Binary search on quality
	let low = MIN_QUALITY;
	let high = INITIAL_QUALITY;
	let best: Uint8Array = bestData;
	const totalTrials = Math.ceil(Math.log2(INITIAL_QUALITY - MIN_QUALITY + 1));
	let trial = 0;

	console.log(`[image] binary searching quality ${low}–${high} (≈${totalTrials} trials)`);

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		image.quality = mid;
		// eslint-disable-next-line no-await-in-loop
		const data = await writeImage(image);

		trial++;
		const pct = Math.round(startPct + range * (trial / totalTrials));
		// eslint-disable-next-line no-await-in-loop
		await reportProgress(onProgress, pct, `Quality ${mid}…`);

		console.log(`[image]   trial ${trial}/${totalTrials}: quality ${mid} → ${(data.length / 1024).toFixed(1)} KB ${data.length <= MAX_BYTES ? '✓' : '✗'}`);

		if (data.length <= MAX_BYTES) {
			best = data;
			low = mid + 1; // Try higher quality
		} else {
			high = mid - 1; // Reduce quality
		}
	}

	console.log(`[image] best quality found: ${image.quality}, ${(best.length / 1024).toFixed(1)} KB`);

	// If even at lowest quality it's still too big, reduce dimensions
	if (best.length > MAX_BYTES && baseWidth > 200 && baseHeight > 200) {
		const factor = 1.5;
		const newWidth = Math.round(baseWidth / factor);
		const newHeight = Math.round(baseHeight / factor);

		console.log(`[image] still over limit — reducing dimensions to ${newWidth}×${newHeight}`);
		await reportProgress(onProgress, 40 + depth * 10, `Reducing to ${newWidth}×${newHeight}…`);

		image.resize(newWidth, newHeight);
		return binarySearchQuality(image, newWidth, newHeight, onProgress, depth + 1);
	}

	return best;
}

/**
 * After finding a quality that works, try to nudge it up for better quality.
 * Reports progress in the range [startPct + 10, 90].
 */
async function refineQuality(
	image: IMagickImage,
	low: number,
	high: number,
	onProgress?: (progress: CompressionProgress) => void,
	startPct = 30
): Promise<Uint8Array> {
	const range = 90 - (startPct + 10);
	let bestLow = low;
	let bestHigh = high;
	let bestData = await writeImage(image);
	const totalTrials = Math.ceil(Math.log2(high - low + 1));
	let trial = 0;

	console.log(`[image] refining quality ${low}–${high} (≈${totalTrials} trials)`);

	while (bestLow <= bestHigh) {
		const mid = Math.floor((bestLow + bestHigh) / 2);
		image.quality = mid;
		// eslint-disable-next-line no-await-in-loop
		const data = await writeImage(image);

		trial++;
		// eslint-disable-next-line no-await-in-loop
		await reportProgress(onProgress, Math.round(startPct + 10 + range * (trial / totalTrials)), `Refining quality ${mid}…`);

		console.log(`[image]   refine trial ${trial}/${totalTrials}: quality ${mid} → ${(data.length / 1024).toFixed(1)} KB ${data.length <= MAX_BYTES ? '✓' : '✗'}`);

		if (data.length <= MAX_BYTES) {
			bestData = data;
			bestLow = mid + 1;
		} else {
			bestHigh = mid - 1;
		}
	}

	console.log(`[image] refinement done: quality ${image.quality}, ${(bestData.length / 1024).toFixed(1)} KB`);
	return bestData;
}

/**
 * Yield to the browser so it can paint pending UI updates.
 */
function yieldToBrowser(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Report progress through the callback and yield so the UI can paint.
 */
function reportProgress(
	onProgress: ((p: CompressionProgress) => void) | undefined,
	percent: number,
	status: string
): Promise<void> {
	onProgress?.({ percent, status });
	return yieldToBrowser();
}

/**
 * Helper to write the current image to WebP and return the bytes.
 */
function writeImage(image: IMagickImage): Promise<Uint8Array> {
	return new Promise((resolve) => {
		image.write(MagickFormat.WebP, (data: Uint8Array) => resolve(new Uint8Array(data)));
	});
}
