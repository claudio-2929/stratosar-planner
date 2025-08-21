// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Base URL per GitHub Pages (repository name)
  base: "/stratosar-planner/",
  // Build direttamente dentro /docs per Pages
  build: { outDir: "docs" },
});
