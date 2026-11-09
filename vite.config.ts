import { defineConfig } from "vite";
import { writeFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "web",
  plugins: [
    react(),
    {
      name: "keep-go-embed-directory",
      closeBundle() {
        // Keep the tracked placeholder after Vite empties the output directory.
        writeFileSync(new URL("./web/dist/.gitkeep", import.meta.url), "");
      },
    },
  ],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:15789", ws: true } },
  },
});
