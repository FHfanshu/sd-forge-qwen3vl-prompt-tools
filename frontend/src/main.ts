import "./styles.css";
import "./selector-styles.css";
import { installRuntimeContracts, mountSvelteUi, unmountSvelteUi, UI_READY } from "./bootstrap";

if (typeof window !== "undefined") installRuntimeContracts(window);
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mount")) mountSvelteUi();

export { mountSvelteUi, unmountSvelteUi, UI_READY };
