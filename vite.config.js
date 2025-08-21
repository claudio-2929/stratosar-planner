// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Use relative paths so GitHub Pages serves assets correctly from /docs
  base: "./",
  // Build directly into /docs so Pages (main /docs) picks it up
  build: { outDir: "docs" },
});


