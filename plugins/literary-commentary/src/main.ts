import App from './App.svelte';
import { mount } from 'svelte';

mount(App, {
  target: document.getElementById('app')!,
});

// The host waits for this handshake before sending the initial document.
// It also lets the host distinguish a working plugin from a blank iframe whose
// entry HTML loaded but whose JavaScript was blocked or missing.
window.parent.postMessage({ type: 'plugin-ready' }, '*');
