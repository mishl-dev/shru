<script lang="ts">
	import { compressImage, initImageEngine } from '$lib/utils/imageCompressor';
	import { compressVideo, initVideoEngine } from '$lib/utils/videoCompressor';
	import { deriveFileInfo, supportsWasm } from '$lib/utils/fileUtils';
	import type { AppStatus, CompressionProgress, CompressionResult } from '$lib/utils/types';

	let status = $state<AppStatus>('idle');
	let file: File | null = $state(null);
	let fileInfo = $derived(file ? deriveFileInfo(file) : null);
	let progress = $state<CompressionProgress>({ percent: 0, status: '' });
	let result = $state<CompressionResult | null>(null);
	let errorMessage = $state<string | null>(null);
	let dragOver = $state(false);
	let enginesReady = $state(false);

	$effect(() => {
		Promise.all([initImageEngine(), initVideoEngine()])
			.then(() => { enginesReady = true; })
			.catch(() => console.warn('pre-init failed, will retry on demand'));
	});

	function onDrop(e: DragEvent) {
		dragOver = false;
		const files = e.dataTransfer?.files;
		if (files && files.length > 0) setFile(files[0]);
	}

	function onSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = input.files;
		if (files && files.length > 0) setFile(files[0]);
		input.value = '';
	}

	function setFile(f: File) {
		if (result?.url) URL.revokeObjectURL(result.url);
		result = null;
		errorMessage = null;
		status = 'idle';
		progress = { percent: 0, status: '' };
		const info = deriveFileInfo(f);
		if (info.type === 'other') {
			errorMessage = 'unsupported file type';
			file = null;
			return;
		}
		file = f;
		startCompress();
	}

	function clearFile() {
		if (result?.url) URL.revokeObjectURL(result.url);
		file = null;
		result = null;
		errorMessage = null;
		status = 'idle';
		progress = { percent: 0, status: '' };
	}

	async function startCompress() {
		if (!file || !fileInfo) return;
		errorMessage = null;
		result = null;
		progress = { percent: 0, status: '' };
		if (!enginesReady) {
			status = 'loading-engine';
			try {
				await Promise.all([initImageEngine(), initVideoEngine()]);
				enginesReady = true;
			} catch (err) {
				errorMessage = err instanceof Error ? err.message : 'engine failed to load';
				status = 'error';
				return;
			}
		}
		status = 'compressing';
		try {
			let blob: Blob;
			if (fileInfo.type === 'image') {
				blob = await compressImage(file, (p) => (progress = p));
			} else if (fileInfo.type === 'video') {
				blob = await compressVideo(file, (p) => (progress = p));
			} else {
				throw new Error('unsupported file type');
			}
			result = {
				originalSize: file.size,
				compressedSize: blob.size,
				blob,
				url: URL.createObjectURL(blob),
				format: blob.type
			};
			status = 'done';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'compression failed';
			status = 'error';
		}
	}

	function download() {
		if (!result) return;
		const a = document.createElement('a');
		a.href = result.url;
		const base = file?.name?.replace(/\.[^/.]+$/, '') ?? 'file';
		const ext = fileInfo?.type === 'image' ? 'webp' : 'mp4';
		a.download = `${base}-compressed.${ext}`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}

	$effect(() => () => { if (result?.url) URL.revokeObjectURL(result.url); });
</script>

<div class="page">
	<div class="drop"
		class:drop-active={dragOver}
		class:drop-has={status === 'compressing' || status === 'loading-engine' || status === 'done' || status === 'error'}
		ondragover={(e) => { e.preventDefault(); dragOver = true; }}
		ondragleave={() => { dragOver = false; }}
		ondrop={(e) => { e.preventDefault(); onDrop(e); }}
		role="button"
		tabindex="0"
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.target as HTMLElement).querySelector('input')?.click(); } }}
	>
		<input type="file" accept="image/*,video/*" onchange={onSelect} />

		{#if !file}
			<div class="content">
				<p class="hint">drop</p>
				{#if !supportsWasm()}
					<p class="error-txt">WebAssembly not available</p>
				{/if}
			</div>
		{:else if status === 'loading-engine' || status === 'compressing'}
			<div class="content">
				<p class="hint">{file.name}</p>
				<div class="bar-wrap">
					<div class="bar" style="width:{progress.percent}%"></div>
				</div>
			</div>
		{:else if status === 'done' && result}
			<div class="content">
				<div class="preview">
					{#if fileInfo?.type === 'image'}
						<img src={result.url} alt="" />
					{:else if fileInfo?.type === 'video'}
						<video src={result.url} controls muted playsinline></video>
					{/if}
				</div>
				<div class="actions">
					<button class="action" onclick={download} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); download(); } }}>
						download
					</button>
				</div>
				<button class="reset" onclick={clearFile}>back</button>
			</div>
		{:else if status === 'error'}
			<div class="content">
				<p class="error-txt">{errorMessage}</p>
				<button class="reset" onclick={clearFile}>back</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.drop {
		width: 100%;
		max-width: 520px;
		min-height: 240px;
		padding: 2rem;
		border-radius: 10px;
		background: var(--surface);
		border: 1px solid var(--border);
		position: relative;
		cursor: pointer;
		transition:
			border-color 0.2s ease,
			background 0.2s ease;
		display: flex;
		align-items: center;
		justify-content: center;
		user-select: none;
	}

	.drop:hover {
		border-color: var(--border-hover);
	}

	.drop.drop-active,
	.drop.drop-has {
		border-color: var(--accent);
		background: var(--surface-2);
	}

	.drop.drop-has {
		cursor: default;
	}

	.drop input[type='file'] {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}

	.drop.drop-has input[type='file'] {
		display: none;
	}

	.content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		width: 100%;
		text-align: center;
	}

	.hint {
		font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		font-size: 0.8125rem;
		font-weight: 400;
		color: var(--ink-faint);
		letter-spacing: 0.04em;
		text-transform: lowercase;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bar-wrap {
		width: 100%;
		height: 6px;
		border-radius: 3px;
		background: var(--border);
		overflow: hidden;
	}

	.bar {
		height: 100%;
		border-radius: 3px;
		background: var(--accent);
		transition: width 0.15s ease;
	}

	.preview {
		width: 100%;
	}

	.preview img,
	.preview video {
		width: 100%;
		max-height: 220px;
		object-fit: contain;
		border-radius: 6px;
		background: #000;
		display: block;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		width: 100%;
	}

	.actions > * {
		flex: 1;
	}

	.action {
		width: 100%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.75rem 1.25rem;
		font-size: 0.875rem;
		font-weight: 500;
		line-height: 1;
		color: var(--ink);
		background: var(--accent);
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: background 0.15s ease;
		font-family: inherit;
		user-select: none;
	}

	.action:hover {
		background: var(--accent-hover);
	}

	.action:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.error-txt {
		font-size: 0.8125rem;
		color: var(--error);
	}

	.reset {
		display: block;
		background: none;
		border: none;
		font-size: 0.75rem;
		color: var(--ink-faint);
		cursor: pointer;
		margin: 0 auto;
		font-family: inherit;
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		transition: color 0.15s ease;
	}

	.reset:hover {
		color: var(--accent);
	}
</style>
