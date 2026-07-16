import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { CompressionProgress } from './types';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ffmpeg-core served from unpkg CDN to avoid deployment issues with large WASM files.
// Version matches @ffmpeg/core in package.json.
const CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';
const WASM_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';

interface EncodeAttempt {
		crf: number;
		resolution: string;
		audioBitrate: string;
		audioChannels: number;
		label: string;
	}
	
	/**
	 * Progressive encoding strategies from best quality to most aggressive.
	 * Each step tries harder compression to get under 10 MB.
	 */
	const ATTEMPTS: EncodeAttempt[] = [
		{
			crf: 23,
			resolution: '1920:1080',
			audioBitrate: '128k',
			audioChannels: 2,
			label: '1080p High Quality'
		},
		{
			crf: 28,
			resolution: '1280:720',
			audioBitrate: '96k',
			audioChannels: 2,
			label: '720p Balanced'
		},
		{
			crf: 32,
			resolution: '854:480',
			audioBitrate: '64k',
			audioChannels: 1,
			label: '480p Aggressive'
		},
		{
			crf: 40,
			resolution: '640:360',
			audioBitrate: '48k',
			audioChannels: 1,
			label: '360p Maximum'
		}
	];

let ffmpeg: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

/**
 * Lazily initialize the ffmpeg WASM engine.
 * Loads ffmpeg-core from CDN directly.
 * Guards against concurrent initialization via a shared promise,
 * and recreates the instance if loading fails.
 */
async function ensureFfmpeg(
	onProgress?: (progress: CompressionProgress) => void
): Promise<FFmpeg> {
	if (ffmpeg) {
		console.log('[video] engine already loaded');
		return ffmpeg;
	}
	if (ffmpegLoadPromise) return ffmpegLoadPromise;

	console.log('[video] initializing ffmpeg WASM…');
	onProgress?.({ percent: 0, status: 'Loading video compression engine…' });

	ffmpegLoadPromise = (async () => {
		const instance = new FFmpeg();
		instance.on('log', ({ message }: { message: string }) => {
			console.log('[ffmpeg]', message);
		});

		try {
			await instance.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
			ffmpeg = instance;
			console.log('[video] ffmpeg WASM ready');
		} catch (err) {
			ffmpegLoadPromise = null; // Allow next caller to retry with a fresh instance
			console.error('[video] failed to load ffmpeg WASM:', err);
			throw new Error('Failed to load video compression engine.');
		}

		return ffmpeg!;
	})();

	return ffmpegLoadPromise;
}

/**
 * Probe a video file to get its duration in seconds.
 */
async function probeDuration(
	ff: FFmpeg,
	inputName: string
): Promise<number | null> {
	try {
		await ff.ffprobe([
			'-v',
			'error',
			'-show_entries',
			'format=duration',
			'-of',
			'default=noprint_wrappers=1:nokey=1',
			inputName,
			'-o',
			'duration.txt'
		]);
		const data = await ff.readFile('duration.txt', 'utf8');
		const duration = parseFloat(data as string);
		return isNaN(duration) ? null : duration;
	} catch {
		// ffprobe might not be available in all builds
		return null;
	}
}

/**
 * Scale filter expression respecting source aspect ratio,
 * only downscaling (never upscaling).
 * Uses ffmpeg's min() function with correct syntax: min(a,b)
 */
function scaleFilter(resolution: string): string {
	const [w, h] = resolution.split(':');
	return `scale='min(${w},iw)':'min(${h},ih)':force_original_aspect_ratio=decrease`;
}

/**
 * Build ffmpeg arguments for a compression attempt.
 */
function buildArgs(
	inputName: string,
	outputName: string,
	attempt: EncodeAttempt
): string[] {
	return [
		'-i',
		inputName,
		'-c:v',
		'libx264',
		'-preset',
		'fast',
		'-crf',
		String(attempt.crf),
		'-vf',
		scaleFilter(attempt.resolution),
		'-c:a',
		'aac',
		'-b:a',
		attempt.audioBitrate,
		'-ac',
		String(attempt.audioChannels),
		'-movflags',
		'+faststart',
		outputName
	];
}

/**
 * Pre-initialize the ffmpeg WASM engine.
 * Call early so it's ready when the user clicks compress.
 */
export async function initVideoEngine(): Promise<void> {
	await ensureFfmpeg();
}

/**
 * Compress a video file to under 10MB using ffmpeg WASM.
 */
export async function compressVideo(
	file: File,
	onProgress?: (progress: CompressionProgress) => void
): Promise<Blob> {
	const ff = await ensureFfmpeg(onProgress);

	const inputName = 'input' + getExtension(file.name);
	const outputName = 'output.mp4';

	console.log(`[video] compressing ${file.name} — ${(file.size / (1024 * 1024)).toFixed(2)} MB, type: ${file.type}`);

	// Write input file to virtual FS
	onProgress?.({ percent: 5, status: 'Reading video file…' });
	const fileData = await fetchFile(file);
	await ff.writeFile(inputName, fileData);
	console.log(`[video] input written to virtual FS as ${inputName}`);

	// Try to probe duration for progress estimation
	onProgress?.({ percent: 10, status: 'Analyzing video…' });
	const duration = await probeDuration(ff, inputName);
	if (duration) {
		console.log(`[video] duration: ${duration.toFixed(1)}s`);
	} else {
		console.log('[video] could not probe duration');
	}

	// Try each encoding tier
	let lastError: string | null = null;
	let attemptIndex = 0;

	// Shared progress listener reference so we can clean up between attempts
	let progressCallback: ((e: { progress: number }) => void) | null = null;

	for (const attempt of ATTEMPTS) {
		attemptIndex++;
		const startPercent = 15 + (attemptIndex - 1) * 20;
		const endPercent = Math.min(15 + attemptIndex * 20, 90);

		console.log(`[video] attempt ${attemptIndex}/${ATTEMPTS.length}: ${attempt.label} (CRF ${attempt.crf}, ${attempt.resolution})`);

		onProgress?.({
			percent: startPercent,
			status: `Encoding (${attempt.label})…`
		});

		// Clean up any previous output
		try {
			await ff.deleteFile(outputName);
		} catch {
			// File may not exist yet
		}

		// Remove previous progress listener to avoid accumulation
		if (progressCallback) {
			ff.off('progress', progressCallback);
		}

		try {
			const args = buildArgs(inputName, outputName, attempt);
			console.log(`[video]   args: ffmpeg ${args.join(' ')}`);

			// Set up progress listener for this attempt
			progressCallback = ({ progress: p }: { progress: number }) => {
				const mappedPercent = startPercent + (endPercent - startPercent) * p;
				onProgress?.({
					percent: Math.round(mappedPercent),
					status: `Encoding (${attempt.label})…`
				});
			};
			ff.on('progress', progressCallback);

			const exitCode = await ff.exec(args, 120000); // 2 min timeout per attempt

			if (exitCode !== 0) {
				console.warn(`[video]   ffmpeg exited with code ${exitCode}`);
				lastError = `FFmpeg exited with code ${exitCode}`;
				continue;
			}

				// Read output and check size
					const outputData = await ff.readFile(outputName);
					// .slice(0) copies out of WASM memory and satisfies BlobPart typing
					const outputBytes =
						outputData instanceof Uint8Array
							? outputData.slice(0)
							: new TextEncoder().encode(outputData ?? '').slice(0);

				const sizeMB = (outputBytes.length / (1024 * 1024)).toFixed(2);
				console.log(`[video]   output: ${sizeMB} MB — ${outputBytes.length <= MAX_BYTES ? '✓ under limit' : '✗ over limit'}`);

				if (outputBytes.length <= MAX_BYTES) {
					// Success!
					const savedPct = Math.round((1 - outputBytes.length / file.size) * 100);
					console.log(`[video] ✓ compressed ${(file.size / (1024 * 1024)).toFixed(2)} MB → ${sizeMB} MB (${savedPct}% saved)`);

					onProgress?.({
						percent: 95,
						status: `Compressed to ${sizeMB} MB`
					});

					// Clean up virtual FS
					try {
						await ff.deleteFile(inputName);
						await ff.deleteFile(outputName);
					} catch {
						// Best effort cleanup
					}

					return new Blob([outputBytes], { type: 'video/mp4' });
				}

			lastError = `Output (${sizeMB} MB) exceeds limit`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			console.warn(`[video]   attempt ${attemptIndex} failed:`, lastError);
		}
	}

	// Clean up virtual FS and progress listener
	try {
		await ff.deleteFile(inputName);
		await ff.deleteFile(outputName);
	} catch {
		// Best effort
	}
	if (progressCallback) {
		ff.off('progress', progressCallback);
	}

	console.error(`[video] all attempts failed. last error: ${lastError}`);
	throw new Error(
		`Could not compress under 10 MB. Last error: ${lastError ?? 'Unknown error'}`
	);
}

/**
 * Get file extension from filename, with a dot prefix.
 */
function getExtension(filename: string): string {
	const dot = filename.lastIndexOf('.');
	if (dot === -1) return '.mp4';
	return filename.slice(dot);
}
