import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { CompressionProgress } from './types';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB target
const ATTEMPT_TIMEOUT = 40 * 60 * 1000; // 40 minutes per attempt
const MAX_LOG_LINES = 500;

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

interface BestResult {
	bytes: Uint8Array;
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

/** Internal cancel callback — wired up per invocation. */
let _cancel: (() => void) | null = null;

/**
 * Cancel an in-progress compression.
 * The ffmpeg WASM instance is discarded (it may be in an unknown state)
 * and will be re-created on the next call to compressVideo.
 */
export function cancelCompression(): void {
	_cancel?.();
}

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
 * Compress a video file using ffmpeg WASM.
 *
 * Tries progressive encoding strategies from best quality to most aggressive.
 * Returns the first result that fits under 10 MB. If none do, returns the
 * smallest result across all attempts (best effort).
 *
 * Supports cancellation — call cancelCompression() to abort.
 * ffmpeg log output is captured and included in progress updates.
 */
export async function compressVideo(
	file: File,
	onProgress?: (progress: CompressionProgress) => void
): Promise<Blob> {
	// Cancel any prior in-flight compression
	_cancel?.();

	const ff = await ensureFfmpeg(onProgress);

	const inputName = 'input' + getExtension(file.name);
	const outputName = 'output.mp4';

	// ── cancellation plumbing ──────────────────────────────────────────
	let aborted = false;
	const abortController = new AbortController();
	const signal = abortController.signal;

	_cancel = () => {
		if (aborted) return;
		aborted = true;
		abortController.abort();
		// Discard instance so next compression starts fresh
		ffmpeg = null;
		ffmpegLoadPromise = null;
	};

	// ── log collector ──────────────────────────────────────────────────
	const logs: string[] = [];
	const logHandler = ({ message }: { message: string }) => {
		if (logs.length < MAX_LOG_LINES) {
			logs.push(message);
		} else if (logs.length === MAX_LOG_LINES) {
			logs.push('… (truncated)');
		}
	};
	ff.on('log', logHandler);

	/** Check cancellation flag and throw if set. */
	function checkAborted(): void {
		if (aborted) throw new Error('Cancelled');
	}

	/** Emit progress with a snapshot of accumulated logs. */
	function emitProgress(percent: number, status: string): void {
		onProgress?.({
			percent,
			status,
			logs: [...logs]
		});
	}

	let progressCallback: ((e: { progress: number }) => void) | null = null;
	let bestResult: BestResult | null = null;

	try {
		console.log(
			`[video] compressing ${file.name} — ${(file.size / (1024 * 1024)).toFixed(2)} MB, type: ${file.type}`
		);

		// ── write input to virtual FS ──────────────────────────────────
		emitProgress(5, 'Reading video file…');
		const fileData = await fetchFile(file);
		await ff.writeFile(inputName, fileData);
		console.log(`[video] input written to virtual FS as ${inputName}`);
		checkAborted();

		// ── probe duration ─────────────────────────────────────────────
		emitProgress(10, 'Analyzing video…');
		const duration = await probeDuration(ff, inputName);
		if (duration) {
			console.log(`[video] duration: ${duration.toFixed(1)}s`);
		} else {
			console.log('[video] could not probe duration');
		}

		// ── progressive encoding passes ────────────────────────────────
		let lastError: string | null = null;
		let attemptIndex = 0;

		for (const attempt of ATTEMPTS) {
			checkAborted();
			attemptIndex++;
			const startPercent = 15 + (attemptIndex - 1) * 20;
			const endPercent = Math.min(15 + attemptIndex * 20, 90);

			console.log(
				`[video] attempt ${attemptIndex}/${ATTEMPTS.length}: ${attempt.label} (CRF ${attempt.crf}, ${attempt.resolution})`
			);
			emitProgress(startPercent, `Encoding (${attempt.label})…`);

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
					emitProgress(Math.round(mappedPercent), `Encoding (${attempt.label})…`);
				};
				ff.on('progress', progressCallback);

				// Race encoding against cancellation so we don't wait 40 min if cancelled
				const execPromise = ff.exec(args, ATTEMPT_TIMEOUT);
				const cancelPromise = new Promise<never>((_, reject) => {
					if (signal.aborted) return reject(new Error('Cancelled'));
					const onAbort = () => reject(new Error('Cancelled'));
					signal.addEventListener('abort', onAbort, { once: true });
					// Clean up listener if exec finishes first
					execPromise.then(
						() => signal.removeEventListener('abort', onAbort),
						() => signal.removeEventListener('abort', onAbort)
					);
				});

				const exitCode = await Promise.race([execPromise, cancelPromise]);

				if (exitCode !== 0) {
					console.warn(`[video]   ffmpeg exited with code ${exitCode}`);
					lastError = `FFmpeg exited with code ${exitCode}`;
					continue;
				}

				// Read output and check size
				const outputData = await ff.readFile(outputName);
				const outputBytes =
					outputData instanceof Uint8Array
						? outputData.slice(0)
						: new TextEncoder().encode(outputData ?? '').slice(0);

				const sizeMB = (outputBytes.length / (1024 * 1024)).toFixed(2);
				console.log(`[video]   output: ${sizeMB} MB`);

				// Track best (smallest) result across all attempts
				if (!bestResult || outputBytes.length < bestResult.bytes.length) {
					bestResult = { bytes: outputBytes, label: attempt.label };
				}

				if (outputBytes.length <= MAX_BYTES) {
					// Under target — return immediately
					const savedPct = Math.round(
						(1 - outputBytes.length / file.size) * 100
					);
					console.log(
						`[video] ✓ ${(file.size / (1024 * 1024)).toFixed(2)} MB → ${sizeMB} MB (${savedPct}% saved)`
					);
					emitProgress(95, `Compressed to ${sizeMB} MB`);
					return new Blob([outputBytes], { type: 'video/mp4' });
				}

				console.log(`[video]   ${sizeMB} MB — over target, trying next pass`);
				lastError = `Output (${sizeMB} MB) exceeds target`;
			} catch (err) {
				if (aborted) throw new Error('Cancelled');
				lastError = err instanceof Error ? err.message : String(err);
				console.warn(`[video]   attempt ${attemptIndex} failed:`, lastError);
			}
		}

		// ── all attempts exhausted — return best effort ────────────────
		if (bestResult) {
			const sizeMB = (bestResult.bytes.length / (1024 * 1024)).toFixed(2);
			console.log(`[video] ✓ best effort: ${sizeMB} MB (${bestResult.label})`);
			emitProgress(95, `Best effort: ${sizeMB} MB (${bestResult.label})`);
			return new Blob([bestResult.bytes], { type: 'video/mp4' });
		}

		// Nothing produced usable output
		console.error(`[video] all attempts failed. last error: ${lastError}`);
		throw new Error(
			`Compression failed. Last error: ${lastError ?? 'Unknown error'}`
		);
	} finally {
		// ── teardown ──────────────────────────────────────────────────
		_cancel = null;
		ff.off('log', logHandler);
		if (progressCallback) {
			ff.off('progress', progressCallback);
		}
		try {
			await ff.deleteFile(inputName);
		} catch {
			/* best effort */
		}
		try {
			await ff.deleteFile(outputName);
		} catch {
			/* best effort */
		}
	}
}

/**
 * Get file extension from filename, with a dot prefix.
 */
function getExtension(filename: string): string {
	const dot = filename.lastIndexOf('.');
	if (dot === -1) return '.mp4';
	return filename.slice(dot);
}
