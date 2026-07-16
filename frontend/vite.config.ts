import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [svelte(), cssInjectedByJsPlugin()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    outDir: "../javascript",
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: `${rootDir}src/main.ts`,
      // Keep the IIFE export separate from the runtime contract installed by bootstrap.
      name: "KohakuLoomSvelteUiBundle",
      formats: ["iife"],
      fileName: () => "kohaku_loom_90_ui.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
