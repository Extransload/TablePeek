import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // The engine descriptions are the server's JSON files under crates/, which
  // the web bundles too; the dev server may read them from the repository.
  server: {
    fs: { allow: [".."] },
  },
  build: {
    outDir: "dist",
    target: "es2020",
    emptyOutDir: true,
  },
});
