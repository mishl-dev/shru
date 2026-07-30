// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/**
	 * navigator.deviceMemory is available in Chromium-based browsers
	 * (Chrome, Edge, Opera, Brave) — gives system RAM in GiB.
	 * Type it globally so getMaxInputBytes() doesn't need a cast.
	 */
	interface Navigator {
		readonly deviceMemory?: number;
	}
}

export {};
