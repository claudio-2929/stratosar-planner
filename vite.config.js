// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/stratosar-planner/',        // necessario per GitHub Pages (repo name)
  build: { outDir: 'docs' },          // pubblicheremo la cartella docs/
})
