export type FileType = 'image' | 'video' | 'other';

export type AppStatus = 'idle' | 'loading-engine' | 'compressing' | 'done' | 'error';

export interface FileInfo {
	name: string;
	size: number;
	type: FileType;
	mime: string;
	dimensions?: { width: number; height: number };
	duration?: number;
}

export interface CompressionResult {
	originalSize: number;
	compressedSize: number;
	blob: Blob;
	url: string;
	format: string;
	iterations?: number;
}

export interface CompressionProgress {
	percent: number;
	status: string;
}
