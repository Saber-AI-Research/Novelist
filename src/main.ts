import App from "./App.svelte";
import { mount } from "svelte";
import { i18n } from "$lib/i18n";
import "./app.css";

i18n.init();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
