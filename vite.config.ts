import vercel from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter: vercel()
		})
	],

	// WASM packages should not be pre-bundled by Vite
	optimizeDeps: {
		exclude: ['@ffmpeg/ffmpeg', '@imagemagick/magick-wasm']
	},

	// @imagemagick/magick-wasm needs to be processed by Vite for WASM imports
	ssr: {
		noExternal: ['@imagemagick/magick-wasm']
	}
});
