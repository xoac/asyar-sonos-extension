import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineExtensionConfig } from 'asyar-sdk/vite';

// Worker (background commands) plus one view (Sonos Control Center); the helper finds worker.html and view.html.
export default defineExtensionConfig({ root: import.meta.dirname, config: { plugins: [svelte()] } });
