import App from './App.svelte';
import { mount } from 'svelte';

// Mounting is synchronous: App connects to the host channel during component
// init (before the iframe's load event hands over the port) and announces
// `plugin-ready` once mounted.
mount(App, {
  target: document.getElementById('app')!,
});
