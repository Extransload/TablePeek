import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { ompSource, type OmpTheme } from "./src/themes/omp";

// Tern's themes (oh-my-pi's theme files, src/themes/tern) as the colour
// tables and surfaces the app makes themes of: "virtual:tern-themes", loaded
// only when wanted (see src/ternThemes.ts).
function ternThemes(): Plugin {
  const id = "virtual:tern-themes";
  const resolved = `\0${id}`;
  const dir = fileURLToPath(new URL("./src/themes/tern", import.meta.url));
  return {
    name: "tablepeek-tern-themes",
    resolveId(source) {
      return source === id ? resolved : null;
    },
    load(source) {
      if (source !== resolved) {
        return null;
      }
      const sources = readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => {
          const path = join(dir, file);
          this.addWatchFile(path);
          return ompSource(JSON.parse(readFileSync(path, "utf8")) as OmpTheme);
        });
      return `export default ${JSON.stringify(sources)};`;
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), ternThemes()],
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
