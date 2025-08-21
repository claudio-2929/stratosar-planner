// src/main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom"; // sicuro su GitHub Pages
import App from "./App.jsx";
import "./index.css"; // assicurati di importare i CSS globali

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
