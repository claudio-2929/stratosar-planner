# Involve Space — StratoSAR Planner (SaaS / Tasking)

React + Vite + Tailwind app per calcolo preventivi **SaaS** (annuale) e **Tasking** (per missione).

## Avvio locale
```bash
npm install
npm run dev
```

Apri l'URL indicato (di solito http://localhost:5173).

## Build produzione
```bash
npm run build
npm run preview
```

## Deploy suggeriti
- **Vercel** o **Netlify**: collega il repo, usa command `npm run build` e `dist/` come output.
- **GitHub Pages**: `npm run build` poi pubblica la cartella `dist`.

## Struttura
- `src/App.jsx`: logica planner (SaaS / Tasking)
- `src/main.jsx`: bootstrap React
- `index.html`: entry
- `tailwind.config.js`, `postcss.config.js`, `src/index.css`: setup Tailwind

## Note
- Modalità **Tasking** accetta **# missioni** manuale.
- Le classi Tailwind replicano lo stile visto nel canvas.
