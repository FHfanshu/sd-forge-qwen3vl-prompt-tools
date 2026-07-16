import type { SvelteUiGlobal } from "./bootstrap";
import type { KohakuLoomNamespace } from "./bridge";

declare global {
  interface Window {
    kohakuLoom?: KohakuLoomNamespace;
    KohakuLoomSvelteUi?: SvelteUiGlobal;
  }
}

export {};
