// src/presets.js

export const DEFAULT_AOI_PRESETS = [
    { id: "milano", name: "Milano (prov.)",   aoiType: "areal",    aoi_km2: 1576, aoi_width_km: null, corridor_width_km: 0.8 },
    { id: "roma",   name: "Roma (prov.)",     aoiType: "areal",    aoi_km2: 5352, aoi_width_km: null, corridor_width_km: 0.8 },
    { id: "torino", name: "Torino (prov.)",   aoiType: "areal",    aoi_km2: 6829, aoi_width_km: null, corridor_width_km: 0.8 },
    { id: "corr-100x2", name: "Corridoio 100×2 km", aoiType: "corridor", aoi_km2: 200,  aoi_width_km: null, corridor_width_km: 2 }
  ];
  
  // chiave di storage
  const KEY = "stratosar:aoi-presets:v1";
  
  // utilities storage
  export function loadPresets() {
    try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch {}
    return DEFAULT_AOI_PRESETS;
  }
  export function savePresets(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
  }
  export function upsertPreset(list, preset) {
    const i = list.findIndex(p => p.id === preset.id);
    const next = [...list];
    if (i >= 0) next[i] = preset; else next.push(preset);
    savePresets(next);
    return next;
  }
  export function removePreset(list, id) {
    const next = list.filter(p => p.id !== id);
    savePresets(next);
    return next;
  }
  export const slug = s =>
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || `aoi-${Date.now()}`;
  