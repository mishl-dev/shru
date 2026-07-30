import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import type { CompressionProgress } from './types';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB Discord limit

/**
 * Aim below the hard limit: container muxing adds ~1% and single-pass
 * rate control can overshoot target bitrate by several percent on
 * hard-to-compress content.
 */
const TARGET_BYTES = Math.floor(MAX_BYTES * 0.92);

/** Safety net for a hung ffmpeg call — never the selection mechanism. */
const ENCODE_TIMEOUT = 40 * 60 * 1000;

const MAX_LOG_LINES = 500;

/** 1 planned encode + up to 2 measured corrections. */
const MAX_PASSES = 3;

/** Below this bitrate video becomes unintelligible. */
const MIN_VIDEO_BPS = 100_000;

/**
 * Inputs larger than this will crash the tab: the whole file is copied
 * into the WASM heap (and once through the JS heap), and the wasm32
 * ffmpeg build can only address ~2–4 GB total. This is an architectural
 * limit of in-browser transcoding, not a policy choice.
 */
export const MAX_INPUT_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);

/** Total bitrate floor: minimum video + minimum audio (48k mono AAC). */
const FLOOR_TOTAL_BPS = MIN_VIDEO_BPS + 48_000;

/**
 * Longest video that can plausibly fit the 10 MB target at the quality
 * floor, plus 15% slack for best-effort attempts. Anything longer can
 * never fit no matter what we do — don't burn the CPU finding out.
 */
export function maxFeasibleSeconds(): number {
	return ((TARGET_BYTES * 8) / FLOOR_TOTAL_BPS) * 1.15;
}

/** Estimated mp4 container overhead, as a fraction of output size. */
const MUX_OVERHEAD_RATIO = 0.01;

// ffmpeg-core served from unpkg CDN to avoid deployment issues with large WASM files.
// Version matches @ffmpeg/core in package.json.
const CORE_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';
const WASM_URL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';

interface AudioPlan {
	bitrate: string;
	bps: number;
	channels: number;
}

interface ResolutionTier {
	width: number;
	height: number;
	/** Minimum bits/pixel/frame that keeps this tier worth using. */
	minBpp: number;
	label: string;
}

interface EncodePlan {
	videoBps: number;
	audio: AudioPlan;
	tierIndex: number;
	fpsCap: number | null;
	label: string;
}

interface ProbeResult {
	duration: number | null;
	fps: number | null;
}

/**
 * Resolution ladder, best quality first. The largest tier whose bitrate
 * budget sustains a sane bits-per-pixel ratio is selected, instead of
 * blindly trying each one.
 */
const TIERS: ResolutionTier[] = [
	{ width: 1920, height: 1080, minBpp: 0.06, label: '1080p' },
	{ width: 1280, height: 720, minBpp: 0.06, label: '720p' },
	{ width: 960, height: 540, minBpp: 0.05, label: '540p' },
	{ width: 854, height: 480, minBpp: 0.04, label: '480p' },
	{ width: 640, height: 360, minBpp: 0, label: '360p' }
];

/** Framerate caps tried (in order) when the bitrate budget is tight. */
const FPS_CAPS = [60, 30, 24];

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
 * Probe a video file for its duration and average framerate.
 * Both feed the bitrate budget calculation.
 */
async function probeMetadata(ff: FFmpeg, inputName: string): Promise<ProbeResult> {
	const result: ProbeResult = { duration: null, fps: null };
	try {
		await ff.ffprobe([
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'format=duration:stream=avg_frame_rate',
			'-of',
			'default=noprint_wrappers=1',
			inputName,
			'-o',
			'probe.txt'
		]);
		const text = (await ff.readFile('probe.txt', 'utf8')) as string;
		for (const line of text.split('\n')) {
			const eq = line.indexOf('=');
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			const value = line.slice(eq + 1).trim();
			if (key === 'duration') {
				const d = parseFloat(value);
				if (!isNaN(d) && d > 0) result.duration = d;
			} else if (key === 'avg_frame_rate') {
				// Rational number, e.g. "30000/1001"
				const [num, den] = value.split('/').map(Number);
				if (num > 0 && den > 0) result.fps = num / den;
			}
		}
	} catch {
		console.warn('[video] metadata probe failed — will fall back to CRF mode');
	}
	return result;
}

/**
 * Pick an audio configuration that fits the total bitrate budget.
 * Audio is allocated first so the video gets whatever remains.
 */
function pickAudio(totalBps: number): AudioPlan {
	if (totalBps >= 2_000_000) return { bitrate: '128k', bps: 128_000, channels: 2 };
	if (totalBps >= 700_000) return { bitrate: '96k', bps: 96_000, channels: 2 };
	if (totalBps >= 250_000) return { bitrate: '80k', bps: 80_000, channels: 1 };
	return { bitrate: '48k', bps: 48_000, channels: 1 };
}

/**
 * Pick the largest resolution tier the video bitrate can sustain.
 * If the budget is too tight, lowering the framerate is preferable to
 * lowering resolution further. Returns the chosen tier and an fps cap
 * (null = keep source framerate).
 */
function pickTier(
	videoBps: number,
	sourceFps: number
): { tierIndex: number; fpsCap: number | null } {
	// Distinct effective framerates, highest first: source, 30, 24
	const fpsOptions = [...new Set([sourceFps, 30, 24].map((c) => Math.min(sourceFps, c)))];

	for (let t = 0; t < TIERS.length; t++) {
		const tier = TIERS[t];
		for (const effFps of fpsOptions) {
			const bpp = videoBps / (effFps * tier.width * tier.height);
			if (bpp >= tier.minBpp) {
				return { tierIndex: t, fpsCap: effFps < sourceFps ? effFps : null };
			}
		}
	}
	// Budget below every floor — smallest tier, lowest framerate
	return {
		tierIndex: TIERS.length - 1,
		fpsCap: Math.min(sourceFps, 24) < sourceFps ? 24 : null
	};
}

/**
 * Compute an encode plan from the bitrate budget:
 *   total bits = target bytes × 8
 *   total bitrate = total bits ÷ duration
 *   video bitrate = total − audio
 * Then pick the highest resolution/framerate the video bitrate sustains.
 */
function computePlan(duration: number, sourceFps: number): EncodePlan {
	const totalBps = (TARGET_BYTES * 8) / duration;
	const audio = pickAudio(totalBps);
	const videoBps = Math.max(totalBps - audio.bps, MIN_VIDEO_BPS);
	const { tierIndex, fpsCap } = pickTier(videoBps, sourceFps);
	return makePlan(videoBps, audio, tierIndex, fpsCap);
}

function makePlan(
	videoBps: number,
	audio: AudioPlan,
	tierIndex: number,
	fpsCap: number | null
): EncodePlan {
	const tier = TIERS[tierIndex];
	const vKbps = Math.round(videoBps / 1000);
	const aKbps = audio.bps / 1000;
	return {
		videoBps,
		audio,
		tierIndex,
		fpsCap,
		label: `${tier.label} ~${vKbps}k video + ${aKbps}k audio${fpsCap ? ` @ ${fpsCap}fps` : ''}`
	};
}

/**
 * Recompute the plan after a pass overshot the target.
 *
 * Only the video stream scales with bitrate — audio and container
 * overhead are (near-)constant, so we subtract them before scaling.
 * Drastic bitrate cuts also drop a resolution tier, since the current
 * one would starve at the new budget.
 */
function correctedPlan(
	plan: EncodePlan,
	duration: number,
	sourceFps: number,
	actualBytes: number
): EncodePlan {
	const audioBytesEst = (plan.audio.bps * duration) / 8;
	const actualVideoBytes = Math.max(
		actualBytes - audioBytesEst - actualBytes * MUX_OVERHEAD_RATIO,
		1
	);
	const targetVideoBytes = Math.max(
		TARGET_BYTES - audioBytesEst - TARGET_BYTES * MUX_OVERHEAD_RATIO,
		1
	);

	let newBps = plan.videoBps * (targetVideoBytes / actualVideoBytes) * 0.97;
	// Must shrink, never grow, and never below intelligibility
	newBps = Math.min(Math.max(newBps, MIN_VIDEO_BPS), plan.videoBps * 0.95);

	if (newBps >= plan.videoBps - 1) {
		// Already at floor — nothing left to correct
		return plan;
	}

	// Re-pick resolution for the new budget, but never climb back up
	const { tierIndex, fpsCap } = pickTier(newBps, sourceFps);
	return makePlan(newBps, plan.audio, Math.max(tierIndex, plan.tierIndex), fpsCap);
}

/**
 * Scale filter expression respecting source aspect ratio,
 * only downscaling (never upscaling), keeping dimensions even
 * (libx264 requires this for 4:2:0 chroma).
 */
function scaleFilter(tier: ResolutionTier): string {
	return `scale='min(${tier.width},iw)':'min(${tier.height},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/**
 * Build ffmpeg arguments for a bitrate-targeted encode.
 */
function buildArgs(inputName: string, outputName: string, plan: EncodePlan): string[] {
	const tier = TIERS[plan.tierIndex];
	const maxrate = Math.round(plan.videoBps * 1.5);
	const bufsize = Math.round(plan.videoBps * 2);
	const args = [
		'-i',
		inputName,
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-b:v',
		String(Math.round(plan.videoBps)),
		'-maxrate',
		String(maxrate),
		'-bufsize',
		String(bufsize),
		'-vf',
		scaleFilter(tier)
	];
	if (plan.fpsCap) {
		args.push('-r', String(plan.fpsCap));
	}
	args.push(
		'-c:a',
		'aac',
		'-b:a',
		plan.audio.bitrate,
		'-ac',
		String(plan.audio.channels),
		'-movflags',
		'+faststart',
		outputName
	);
	return args;
}

/**
 * Build ffmpeg arguments for a fixed-quality (CRF) encode.
 * Only used when duration can't be determined.
 */
function buildCrfArgs(
	inputName: string,
	outputName: string,
	crf: number,
	tierIndex: number
): string[] {
	return [
		'-i',
		inputName,
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-crf',
		String(crf),
		'-vf',
		scaleFilter(TIERS[tierIndex]),
		'-c:a',
		'aac',
		'-b:a',
		'96k',
		'-ac',
		'2',
		'-movflags',
		'+faststart',
		outputName
	];
}

/**
 * Recover the duration from ffmpeg's own log output
 * ("Duration: 00:01:23.45, ...") — a fallback when ffprobe fails.
 */
function durationFromLogs(logs: string[]): number | null {
	for (const line of logs) {
		const m = line.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
		if (m) {
			return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
		}
	}
	return null;
}

/**
 * Pre-initialize the ffmpeg WASM engine.
 * Call early so it's ready when the user clicks compress.
 */
export async function initVideoEngine(): Promise<void> {
	await ensureFfmpeg();
}

/**
 * Compress a video file to under 10 MB using ffmpeg WASM.
 *
 * Algorithm — budget-based encoding:
 *  1. Probe duration + framerate.
 *  2. Derive the bitrate budget: TARGET_BYTES × 8 ÷ duration.
 *  3. Allocate audio first, give the rest to video, then pick the
 *     highest resolution/framerate that bitrate can sustain
 *     (bits-per-pixel floor per tier).
 *  4. Encode once at that bitrate (single-pass ABR with VBV clamp).
 *  5. If rate control overshot, re-encode with a corrected bitrate
 *     computed from the measured output — at most 2 corrections.
 *
 * This replaces the old approach (4 blind full-length CRF encodes on a
 * quality ladder): typically 1 encode instead of up to 4, and the output
 * size is targeted rather than discovered.
 *
 * If duration can't be probed at all, falls back to a single CRF pass;
 * if that overshoots, the duration is recovered from ffmpeg's logs and
 * the budgeted path takes over.
 *
 * Supports cancellation — call cancelCompression() to abort.
 * ffmpeg log output is captured and included in progress updates.
 */
export async function compressVideo(
	file: File,
	onProgress?: (progress: CompressionProgress) => void,
	meta?: { duration?: number | null }
): Promise<Blob> {
	// Hard guard: beyond this the file copy alone will crash the tab.
	if (file.size > MAX_INPUT_BYTES) {
		throw new Error(
			`file is too large for in-browser compression (limit ~1.5 GB)`
		);
	}

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
	// Also pushes a throttled progress update per log line, so the UI
	// receives fresh logs even when ffmpeg 'progress' events are sparse.
	const logs: string[] = [];
	let currentPercent = 0;
	let currentStatus = '';
	let lastLogEmit = 0;
	const logHandler = ({ message }: { message: string }) => {
		// Rolling window — dropping old lines keeps the live tail moving
		// even on long encodes (a hard cap would freeze it instead).
		if (logs.length >= MAX_LOG_LINES) logs.shift();
		logs.push(message);
		const now = Date.now();
		if (now - lastLogEmit > 250) {
			lastLogEmit = now;
			onProgress?.({
				percent: currentPercent,
				status: currentStatus,
				logs: [...logs]
			});
		}
	};
	ff.on('log', logHandler);

	/** Check cancellation flag and throw if set. */
	function checkAborted(): void {
		if (aborted) throw new Error('Cancelled');
	}

	/** Emit progress with a snapshot of accumulated logs. */
	function emitProgress(percent: number, status: string): void {
		currentPercent = percent;
		currentStatus = status;
		onProgress?.({
			percent,
			status,
			logs: [...logs]
		});
	}

	let progressCallback: ((e: { progress: number }) => void) | null = null;
	let bestResult: { bytes: Uint8Array<ArrayBuffer>; label: string } | null = null;
	let passesUsed = 0;

	/** Progress ranges per pass: [planned, correction 1, correction 2]. */
	const PASS_RANGES: Array<[number, number]> = [
		[15, 70],
		[71, 86],
		[87, 94]
	];

	/**
	 * Run one encode pass, mapping ffmpeg progress onto the given range.
	 * Returns the output bytes; throws on ffmpeg failure.
	 */
	async function encodePass(
		args: string[],
		statusLabel: string
	): Promise<Uint8Array<ArrayBuffer>> {
		checkAborted();
		const [startPct, endPct] = PASS_RANGES[Math.min(passesUsed, PASS_RANGES.length - 1)];
		passesUsed++;

		// Clean up any previous output
		try {
			await ff.deleteFile(outputName);
		} catch {
			// File may not exist yet
		}

		if (progressCallback) {
			ff.off('progress', progressCallback);
		}
		emitProgress(startPct, statusLabel);
		progressCallback = ({ progress: p }: { progress: number }) => {
			const pct = Math.round(startPct + (endPct - startPct) * p);
			// Include the pass-local percentage so the status line shows
			// visible movement throughout the (long) encode.
			emitProgress(pct, `${statusLabel} ${Math.round(p * 100)}%`);
		};
		ff.on('progress', progressCallback);

		console.log(`[video]   args: ffmpeg ${args.join(' ')}`);

		// Race encoding against cancellation so we don't wait around if cancelled
		const execPromise = ff.exec(args, ENCODE_TIMEOUT);
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
			throw new Error(`FFmpeg exited with code ${exitCode}`);
		}

		const outputData = await ff.readFile(outputName);
		return outputData instanceof Uint8Array
			? outputData.slice(0)
			: new TextEncoder().encode(outputData ?? '').slice(0);
	}

	/** Track the smallest output and return it early if it fits. */
	function handleResult(bytes: Uint8Array<ArrayBuffer>, label: string): Blob | null {
		const sizeMB = (bytes.length / (1024 * 1024)).toFixed(2);
		console.log(`[video]   output: ${sizeMB} MB`);

		if (!bestResult || bytes.length < bestResult.bytes.length) {
			bestResult = { bytes, label };
		}

		if (bytes.length <= MAX_BYTES) {
			const savedPct = Math.round((1 - bytes.length / file.size) * 100);
			console.log(
				`[video] ✓ ${(file.size / (1024 * 1024)).toFixed(2)} MB → ${sizeMB} MB (${savedPct}% saved)`
			);
			emitProgress(95, `Compressed to ${sizeMB} MB`);
			return new Blob([bytes], { type: 'video/mp4' });
		}
		console.log(`[video]   ${sizeMB} MB — over target`);
		return null;
	}

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

		// ── probe duration + framerate ─────────────────────────────────
		// Prefer the browser-probed duration (free, no ffprobe needed).
		emitProgress(10, 'Analyzing video…');
		let duration = meta?.duration && meta.duration > 0 ? meta.duration : null;
		let sourceFps = 30;
		if (!duration) {
			const probe = await probeMetadata(ff, inputName);
			duration = probe.duration;
			if (probe.fps && probe.fps >= 1 && probe.fps <= 120) sourceFps = probe.fps;
		}
		if (duration) {
			console.log(
				`[video] duration: ${duration.toFixed(1)}s (${meta?.duration ? 'native' : 'ffprobe'}), fps: ${sourceFps.toFixed(2)}`
			);
		} else {
			console.log('[video] could not probe duration — using CRF fallback');
		}

		// ── CRF fallback when duration is unknown ──────────────────────
		if (!duration) {
			const done = handleResult(
				await encodePass(buildCrfArgs(inputName, outputName, 26, 1), 'Encoding (720p)…'),
				'720p CRF 26'
			);
			if (done) return done;

			// Recover duration from the encode logs and continue targeted
			duration = durationFromLogs(logs);
			if (!duration) {
				// Last resort: one aggressive rung, then best effort
				console.log('[video]   duration unrecoverable — one aggressive CRF pass');
				const last = handleResult(
					await encodePass(buildCrfArgs(inputName, outputName, 33, 3), 'Encoding (480p)…'),
					'480p CRF 33'
				);
				if (last) return last;
				return finishBestEffort();
			}
			console.log(`[video]   duration recovered from logs: ${duration.toFixed(1)}s`);
		}

		// ── budget-targeted passes ─────────────────────────────────────
		const totalBps = (TARGET_BYTES * 8) / duration;
		console.log(
			`[video] bitrate budget: ${Math.round(totalBps / 1000)} kbps total for ${duration.toFixed(1)}s`
		);

		let plan = computePlan(duration, sourceFps);

		while (passesUsed < MAX_PASSES) {
			console.log(`[video] pass ${passesUsed + 1}/${MAX_PASSES}: ${plan.label}`);
			let bytes: Uint8Array<ArrayBuffer>;
			try {
				bytes = await encodePass(
					buildArgs(inputName, outputName, plan),
					`Encoding (${plan.label})…`
				);
			} catch (err) {
				if (aborted) throw new Error('Cancelled');
				console.warn(`[video]   pass ${passesUsed} failed:`, err);
				break; // Return best effort below
			}

			const done = handleResult(bytes, plan.label);
			if (done) return done;

			if (passesUsed >= MAX_PASSES) break;
			const nextPlan = correctedPlan(plan, duration, sourceFps, bytes.length);
			if (nextPlan === plan) {
				console.log('[video]   at bitrate floor — cannot correct further');
				break;
			}
			console.log(`[video]   correcting: ${nextPlan.label}`);
			plan = nextPlan;
		}

		return finishBestEffort();
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
		try {
			await ff.deleteFile('probe.txt');
		} catch {
			/* best effort */
		}
	}

	/** All passes exhausted — return the smallest result we produced. */
	function finishBestEffort(): Blob {
		if (bestResult) {
			const sizeMB = (bestResult.bytes.length / (1024 * 1024)).toFixed(2);
			console.log(`[video] ✓ best effort: ${sizeMB} MB (${bestResult.label})`);
			emitProgress(95, `Best effort: ${sizeMB} MB (${bestResult.label})`);
			return new Blob([bestResult.bytes], { type: 'video/mp4' });
		}
		console.error('[video] all passes failed to produce output');
		throw new Error('Compression failed: ffmpeg could not encode this file.');
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
