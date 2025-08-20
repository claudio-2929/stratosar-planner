import React, { useMemo, useState, useEffect, useRef } from "react";
import { loadPresets, upsertPreset, removePreset, slug } from "./presets.js";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { Button } from "./components/ui/button";

/* ====================== Utils ====================== */
const N = (n, d = 2) =>
  new Intl.NumberFormat("it-IT", { maximumFractionDigits: d }).format(
    isFinite(n) ? n : 0
  );
const EUR = (n, d = 0) =>
  new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  }).format(isFinite(n) ? n : 0);
const ceil = Math.ceil, floor = Math.floor, sqrt = Math.sqrt, PI = Math.PI;
const pdec = (v, fb = "") => {
  if (v === null || v === undefined) return fb;
  const s = String(v).replace(/,/g, ".").trim();
  if (!s) return fb;
  const n = Number(s);
  return Number.isFinite(n) ? n : fb;
};
const fmtDate = (ts) =>
  new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });

/* ====================== Profili tasking ====================== */
const PROFILES = {
  standard: { name: "Standard", D: 1, Cf: 1, Ch: 1, Cons: 1 },
  long: { name: "Long", D: 1.5, Cf: 1.1, Ch: 1, Cons: 1.2 },
  express: { name: "Express", D: 0.7, Cf: 1.15, Ch: 1.15, Cons: 1 },
};

/* ====================== Default params ====================== */
const DEF = {
  mode: "saas",
  platform: "stats",           // "stats" | "relay"
  relay_hours_h: 6,

  aoiType: "areal",
  aoi_km2: 181.8,
  aoi_width_km: null,
  corridor_width_km: 0.8,
  revisit_min: 1440,

  mission_days: 7,
  turnaround_days: 1,

  swath_km: 7,
  ground_speed_kmh: 40,
  duty: 0.75,
  cov_eff: 0.5,
  overlap: 0.2,
  turn_radius_km: 5,
  eta_nav: 0.8,

  mtbf_h: 500,
  mttr_h: 20,

  // stagionalità rimossa
  max_flight_days: 200,
  maint_buffer: 0.25,
  spare_buffer: 0.15,

  Cf_mission: 2500,
  Ch_hour: 25,
  capex_platform_EUR: 20000,
  life_platform_days: 800,
  capex_payload_EUR: 90000,
  life_payload_days: 1200,
  consumables_per_mission: 500,

  annual_cloud_costs: 12000,
  target_gm: 0.5,

  proposed_annual_price_EUR: "",

  missions_count: 6,
  mission_profile: "standard",
  proposed_price_per_mission_EUR: "",

  client_name: "Cliente",
  aoi_name: "AOI",
};

/* ====================== Core model ====================== */
const strips = (type, W, cw, sw, ov) =>
  type === "corridor"
    ? Math.max(1, ceil(pdec(cw, 0) / (sw * (1 - ov))))
    : ceil(W / (sw * (1 - ov)));

const Trepos = (type, n, r, v, eta) =>
  type === "corridor" && n === 1
    ? ((PI * r) / (v * eta)) * 60
    : ((n * PI * r) / (v * eta)) * 60;

function compute(p) {
  const isRelay = p.platform === "relay";
  const A = Math.max(1e-6, pdec(p.aoi_km2, DEF.aoi_km2));
  const W = p.aoi_width_km !== null && p.aoi_width_km !== "" ? pdec(p.aoi_width_km) : sqrt(A);

  const relayH = pdec(p.relay_hours_h, DEF.relay_hours_h);
  const D = isRelay ? Math.max(relayH / 24, 1 / 24) : pdec(p.mission_days, DEF.mission_days);
  const Hh = isRelay ? relayH : D * 24;

  const w = pdec(p.swath_km, DEF.swath_km),
    v = pdec(p.ground_speed_kmh, DEF.ground_speed_kmh),
    d = pdec(p.duty, DEF.duty),
    c = pdec(p.cov_eff, DEF.cov_eff);
  const ov = pdec(p.overlap, DEF.overlap),
    r = pdec(p.turn_radius_km, DEF.turn_radius_km),
    eta = pdec(p.eta_nav, DEF.eta_nav);

  const covRate = w * v * d * c; // km²/h
  const n = strips(p.aoiType, W, p.corridor_width_km, w, ov);
  const Ts = (A / Math.max(covRate, 1e-6)) * 60;
  const Tr = Trepos(p.aoiType, n, r, v, eta);
  const Tc = Ts + Tr;

  const R = pdec(p.revisit_min, DEF.revisit_min);
  const revisitsY = ceil(525600 / R);
  const Kyear = A * revisitsY;

  const Kmis = covRate * Math.max(Hh, 1e-6);
  const Fb = ceil(Kyear / Math.max(Kmis, 1e-6));
  const Ft = Fb;

  const Aavail = Math.min(
    0.999,
    Math.max(0.5, pdec(p.mtbf_h, DEF.mtbf_h) / (pdec(p.mtbf_h, DEF.mtbf_h) + pdec(p.mttr_h, DEF.mttr_h)))
  );
  const usable = pdec(p.max_flight_days, DEF.max_flight_days) * (1 - pdec(p.maint_buffer, DEF.maint_buffer));
  const Fpp = isRelay ? 0 : floor(usable * Aavail / Math.max(D + pdec(p.turnaround_days, DEF.turnaround_days), 0.1));
  const Smin = isRelay ? 1 : ceil(Tc / R);
  const P0 = isRelay ? 1 : Math.max(ceil(Ft / Math.max(Fpp, 1)), Smin);
  const P = isRelay ? 1 : ceil(P0 * (1 + pdec(p.spare_buffer, DEF.spare_buffer)));

  const amortPlat =
    pdec(p.capex_platform_EUR, DEF.capex_platform_EUR) / Math.max(pdec(p.life_platform_days, DEF.life_platform_days), 1);
  const amortPay =
    pdec(p.capex_payload_EUR, DEF.capex_payload_EUR) / Math.max(pdec(p.life_payload_days, DEF.life_payload_days), 1);

  const Cmis =
    pdec(p.Cf_mission, DEF.Cf_mission) +
    pdec(p.Ch_hour, DEF.Ch_hour) * Hh +
    (amortPlat + amortPay) * D +
    pdec(p.consumables_per_mission, DEF.consumables_per_mission);

  const Ann = Ft * Cmis + pdec(p.annual_cloud_costs, DEF.annual_cloud_costs);
  const EURkm2rev = Ann / Math.max(Kyear, 1);
  const EURkm2y = Ann / Math.max(A, 1);
  const PriceGM = Ann / Math.max(1 - pdec(p.target_gm, DEF.target_gm), 0.01);

  let GM = null;
  if (p.proposed_annual_price_EUR !== "" && !isNaN(+p.proposed_annual_price_EUR)) {
    const Puser = Math.max(+p.proposed_annual_price_EUR, 0.01);
    GM = (Puser - Ann) / Puser;
  }

  return {
    isRelay,
    A,
    W,
    D,
    Hh,
    covRate,
    n,
    Ts,
    Tr,
    Tc,
    R,
    revisitsY,
    Kyear,
    Fb,
    Ft,
    Aavail,
    usable,
    Fpp,
    Smin,
    P0,
    P,
    Cmis,
    Ann,
    EURkm2rev,
    EURkm2y,
    PriceGM,
    GM,
    slack: R - Tc,
  };
}

/* ====================== Tasking ====================== */
function taskingCalc(p, m, profileKey) {
  const isRelay = p.platform === "relay";
  const pr = PROFILES[profileKey] || PROFILES.standard;

  const relayH = pdec(p.relay_hours_h, DEF.relay_hours_h);
  const Dbase = isRelay ? Math.max(relayH / 24, 1 / 24) : pdec(p.mission_days, DEF.mission_days);
  const D = Dbase * pr.D;
  const H = D * 24;

  const amortPlat =
    pdec(DEF.capex_platform_EUR, DEF.capex_platform_EUR) / Math.max(pdec(DEF.life_platform_days, DEF.life_platform_days), 1);
  const amortPay =
    pdec(DEF.capex_payload_EUR, DEF.capex_payload_EUR) / Math.max(pdec(DEF.life_payload_days, DEF.life_payload_days), 1);

  const Cmis =
    pdec(p.Cf_mission, DEF.Cf_mission) * pr.Cf +
    pdec(p.Ch_hour, DEF.Ch_hour) * pr.Ch * H +
    (amortPlat + amortPay) * D +
    pdec(p.consumables_per_mission, DEF.consumables_per_mission) * pr.Cons;

  const tot = m * Cmis;

  // Prezzo calcolato a GM target
  const gmTarget = pdec(p.target_gm, DEF.target_gm);
  const pricePerMissionGM = Cmis / Math.max(1 - gmTarget, 0.01);
  const totalPriceGM = pricePerMissionGM * m;

  // Prezzo proposto manuale (se presente)
  const userPmValid = p.proposed_price_per_mission_EUR !== "" && isFinite(+p.proposed_price_per_mission_EUR);
  const userPm = userPmValid ? Math.max(+p.proposed_price_per_mission_EUR, 0.01) : null;
  const userTotal = userPmValid ? userPm * m : null;
  const GMm_user = userPmValid ? (userPm - Cmis) / userPm : null;
  const GMtot_user = userPmValid ? (userTotal - tot) / userTotal : null;

  // Scelta finale: se c'è un prezzo manuale usiamo quello, altrimenti GM target
  const Pm_final = userPmValid ? userPm : pricePerMissionGM;
  const Ptot_final = Pm_final * m;
  const GMm_final = (Pm_final - Cmis) / Pm_final;
  const GMtot_final = (Ptot_final - tot) / Ptot_final;

  return {
    isRelay,
    pr,
    D,
    H,
    Cmis,
    tot,
    // info prezzi
    pricePerMissionGM,
    totalPriceGM,
    userPm,
    userTotal,
    GMm_user,
    GMtot_user,
    // scelti per output principale
    Pm_final,
    Ptot_final,
    GMm_final,
    GMtot_final,
    hasUserPrice: userPmValid,
  };
}

/* ====================== Tooltip (ⓘ) ====================== */
const INFO = {
  mode: { t: "Modalità", d: "SaaS (annuale) o Tasking (per missione/lancio).", f: "—" },
  platform: { t: "Piattaforma", d: "Stratostats (flotta) o Stratorelay (lanci).", f: "Capacità = w·v·d·c·H" },
  aoi_km2: { t: "Area AOI", d: "Superficie da coprire.", f: "Ts = A/(w·v·d·c)" },
  aoi_width_km: { t: "Larghezza AOI", d: "Vuoto = √A.", f: "n ≈ larghezza/(swath·(1−ρ))" },
  corridor_width_km: { t: "Larghezza corridoio", d: "Solo in modalità Corridoio.", f: "n = ceil(W/(swath·(1−ρ)))" },
  revisit_min: { t: "Revisita", d: "Intervallo minimo tra passaggi.", f: "Revisite/anno = 525600/R" },
  mission_days: { t: "Durata missione", d: "Giorni attivi di una missione.", f: "H = D·24" },
  turnaround_days: { t: "Turnaround", d: "Gap tra missioni (Stats).", f: "Voli/pf/anno ≈ giorni_utili·Aavail/(D+turnaround)" },
  swath_km: { t: "Swath", d: "Larghezza strisciata.", f: "Capacità oraria = w·v·d·c" },
  ground_speed_kmh: { t: "Velocità", d: "Velocità al suolo.", f: "Capacità oraria = w·v·d·c" },
  duty: { t: "Duty", d: "Quota tempo utile.", f: "Capacità oraria = w·v·d·c" },
  cov_eff: { t: "Efficienza", d: "Perdite geometriche/operazionali.", f: "Capacità oraria = w·v·d·c" },
  overlap: { t: "Overlap ρ", d: "Sovrapposizione fra strisciate.", f: "n ↑ se ρ ↑" },
  turn_radius_km: { t: "Raggio virata", d: "Influenza T_repos.", f: "T_repos ≈ (n·π·r)/(v·η)" },
  eta_nav: { t: "Efficienza nav", d: "Navigazione/repo.", f: "T_repos ≈ (n·π·r)/(v·η)" },
  mtbf_h: { t: "MTBF", d: "Ore tra guasti.", f: "Aavail ≈ MTBF/(MTBF+MTTR)" },
  mttr_h: { t: "MTTR", d: "Ore riparazione.", f: "Aavail ≈ MTBF/(MTBF+MTTR)" },
  max_flight_days: { t: "Giorni volo max", d: "Budget volabile.", f: "Voli/pf/anno ≈ giorni_utili·Aavail/(D+turnaround)" },
  maint_buffer: { t: "Buffer manut.", d: "Quota giorni non operativi.", f: "giorni_utili = max_flight_days·(1−buffer)" },
  spare_buffer: { t: "Buffer spare", d: "Margine su # piattaforme.", f: "P = ceil(P0·(1+buffer))" },
  Cf_mission: { t: "Costo fisso", d: "Costi diretti per missione/lancio.", f: "C_mis = Cf + Ch·H + ammort. + consumabili" },
  Ch_hour: { t: "€/h", d: "Costo orario.", f: "C_mis include Ch·H" },
  consumables_per_mission: { t: "Consumabili", d: "Materiali consumabili.", f: "Inclusi in C_mis" },
  capex_platform_EUR: { t: "CAPEX piattaforma", d: "Costo piattaforma.", f: "Ammort. = CAPEX/vita_giorni" },
  life_platform_days: { t: "Vita piattaforma", d: "Giorni di vita utile.", f: "Ammort. = CAPEX/vita_giorni" },
  capex_payload_EUR: { t: "CAPEX payload", d: "Costo sensore.", f: "Ammort. = CAPEX/vita_giorni" },
  life_payload_days: { t: "Vita payload", d: "Giorni di vita utile.", f: "Ammort. = CAPEX/vita_giorni" },
  annual_cloud_costs: { t: "Cloud annuo", d: "Storage/compute.", f: "Costo annuo = Ft·C_mis + cloud" },
  target_gm: { t: "GM target", d: "Margine lordo desiderato.", f: "Prezzo_target = costo/(1−GM)" },
};
function InfoTip({ id }) {
  const i = INFO[id] || {};
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => { document.removeEventListener("click", onDocClick); document.removeEventListener("keydown", onEsc); };
  }, []);
  return (
    <span ref={ref} className="relative ml-1 inline-flex align-middle">
      <button
        type="button"
        aria-label={`Info: ${i.t || id}`}
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer text-slate-400 hover:text-slate-200 text-[10px] leading-none inline-flex items-center justify-center w-4 h-4 rounded-full border border-white/20 bg-white/5 focus:outline-none focus:ring-2 focus:ring-[#5fb1ff]"
      >i</button>
      {open && (
        <div role="dialog" aria-label={i.t || "Informazioni"}
             className="absolute left-1/2 z-50 mt-2 w-72 -translate-x-1/2 rounded-lg border border-white/10 bg-slate-900/95 p-3 text-xs shadow-xl">
          <div className="font-semibold text-slate-100 mb-1">{i.t || "Info"}</div>
          <div className="text-slate-300 whitespace-pre-line">{i.d || "—"}</div>
          {i.f && <div className="mt-2 text-slate-400"><span className="opacity-70">Formula: </span><code className="text-[11px] break-words">{i.f}</code></div>}
        </div>
      )}
    </span>
  );
}

/* ====================== Row & Num ====================== */
const Row = ({ l, children, info }) => (
  <div className="grid grid-cols-2 gap-2 py-1">
    <div className="text-sm text-slate-300">{l} {info && <InfoTip id={info} />}</div>
    <div className="text-right">{children}</div>
  </div>
);
const Num = ({ v, on, step = "any" }) => (
  <input
    type="number"
    step={step}
    inputMode="decimal"
    value={v == null ? "" : String(v)}
    onChange={(e) => on(pdec(e.target.value, ""))}
    className="w-full border border-white/10 bg-white/5 text-slate-100 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-[#5fb1ff]"
  />
);

/* ====================== Wizard steps ====================== */
const STEPS = [
  { key: "aoi", title: "AOI & Servizio" },
  { key: "ops", title: "Piattaforma & Ops" },
  { key: "sensor", title: "Sensore & Navigazione" },
  { key: "pricing", title: "Prezzi & Target" },
  { key: "results", title: "Risultati" },
  { key: "history", title: "Storico & Analisi" },
];

/* ====================== Preset locali: Piattaforma/Payload ====================== */
const PLAT_KEY = "stratosar:plat-presets:v1";
const PAY_KEY  = "stratosar:payload-presets:v1";

const loadJSON = (k, fb=[]) => { try { const r = localStorage.getItem(k); return r? JSON.parse(r): fb; } catch { return fb; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function upsert(list, item) {
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) { const copy = list.slice(); copy[i] = item; return copy; }
  return [...list, item];
}
function removeById(list, id) { return list.filter(x => x.id !== id); }

/* ====================== Storico (localStorage) ====================== */
const HIST_KEY = "stratosar:quotes:v1";
function loadHistory() { return loadJSON(HIST_KEY, []); }
function saveHistory(list) { saveJSON(HIST_KEY, list); }
function toCSV(rows) {
  const headers = [
    "id","ts","cliente","aoi","mode","platform","profile",
    "aoi_km2","revisit_min","H_mission","n_strisce",
    "costo_missione","costo_totale","prezzo_target","gm_prop","missions_count"
  ];
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, fmtDate(r.ts), r.client_name, r.aoi_name, r.mode, r.platform, r.mission_profile,
      r.aoi_km2, r.revisit_min, r.Hh, r.n,
      r.Cmis, r.total_cost, r.price_target, r.GM_prop ?? "", r.missions_count ?? ""
    ].map(esc).join(","));
  }
  return lines.join("\n");
}
function quickStats(rows) {
  if (rows.length === 0) return { count: 0, avgPrice: 0, avgCost: 0, avgGM: 0, byPlatform: {} };
  const sum = rows.reduce((acc, r) => {
    acc.price += +r.price_target || 0;
    acc.cost += +r.total_cost || 0;
    if (typeof r.GM_prop === "number") { acc.gm += r.GM_prop; acc.gmN += 1; }
    return acc;
  }, { price: 0, cost: 0, gm: 0, gmN: 0 });
  const byPlatform = rows.reduce((acc, r) => {
    const k = r.platform;
    acc[k] = acc[k] || { count: 0, price: 0, cost: 0 };
    acc[k].count += 1;
    acc[k].price += +r.price_target || 0;
    acc[k].cost += +r.total_cost || 0;
    return acc;
  }, {});
  return {
    count: rows.length,
    avgPrice: sum.price / rows.length,
    avgCost: sum.cost / rows.length,
    avgGM: sum.gmN ? sum.gm / sum.gmN : 0,
    byPlatform,
  };
}

/* ====================== App ====================== */
export default function App() {
  const [p, setP] = useState(DEF);
  const m = useMemo(() => compute(p), [p]);
  const set = (k, v) => setP((prev) => ({ ...prev, [k]: v }));

  const missionsCount = Math.max(0, parseInt(p.missions_count || 0) || 0);
  const t = useMemo(() => taskingCalc(p, missionsCount, p.mission_profile), [p, missionsCount]);

  // AOI presets (già esistenti)
  const [presets, setPresets] = useState(loadPresets());
  const [selectedPresetId, setSelectedPresetId] = useState(presets[0]?.id || "");
  const [presetName, setPresetName] = useState("");

  const loadPreset = () => {
    const pr = presets.find((x) => x.id === selectedPresetId);
    if (!pr) return;
    setP((prev) => ({
      ...prev,
      aoiType: pr.aoiType ?? prev.aoiType,
      aoi_km2: pr.aoi_km2 ?? prev.aoi_km2,
      aoi_width_km: pr.aoi_width_km ?? null,
      corridor_width_km: pr.corridor_width_km ?? prev.corridor_width_km,
    }));
  };
  const saveCurrentAsPreset = () => {
    const name = (presetName || p.aoi_name || `AOI ${Math.round(p.aoi_km2)} km²`).trim();
    const id = slug(name);
    const newPreset = {
      id, name,
      aoiType: p.aoiType,
      aoi_km2: +p.aoi_km2 || 0,
      aoi_width_km: p.aoi_width_km ?? null,
      corridor_width_km: p.corridor_width_km ?? null,
    };
    const updated = upsertPreset(presets, newPreset);
    setPresets(updated);
    setSelectedPresetId(id);
    setPresetName("");
  };
  const deleteSelectedPreset = () => {
    if (!selectedPresetId) return;
    const updated = removePreset(presets, selectedPresetId);
    setPresets(updated);
    setSelectedPresetId(updated[0]?.id || "");
  };

  /* ====== NUOVI PRESET: Piattaforma ====== */
  const [platPresets, setPlatPresets] = useState(loadJSON(PLAT_KEY, []));
  const [platSel, setPlatSel] = useState(platPresets[0]?.id || "");
  const [platName, setPlatName] = useState("");

  const loadPlatPreset = () => {
    const pr = platPresets.find(x => x.id === platSel);
    if (!pr) return;
    setP(prev => ({
      ...prev,
      platform: pr.platform ?? prev.platform,
      relay_hours_h: pr.relay_hours_h ?? prev.relay_hours_h,
      mission_days: pr.mission_days ?? prev.mission_days,
      turnaround_days: pr.turnaround_days ?? prev.turnaround_days,
      mtbf_h: pr.mtbf_h ?? prev.mtbf_h,
      mttr_h: pr.mttr_h ?? prev.mttr_h,
      max_flight_days: pr.max_flight_days ?? prev.max_flight_days,
      maint_buffer: pr.maint_buffer ?? prev.maint_buffer,
      spare_buffer: pr.spare_buffer ?? prev.spare_buffer,
      capex_platform_EUR: pr.capex_platform_EUR ?? prev.capex_platform_EUR,
      life_platform_days: pr.life_platform_days ?? prev.life_platform_days,
    }));
  };
  const savePlatPreset = () => {
    const name = (platName || `${p.platform==='relay'?'Stratorelay':'Stratostats'} preset`).trim();
    const id = slug(name);
    const item = {
      id, name,
      platform: p.platform,
      relay_hours_h: p.relay_hours_h,
      mission_days: p.mission_days,
      turnaround_days: p.turnaround_days,
      mtbf_h: p.mtbf_h,
      mttr_h: p.mttr_h,
      max_flight_days: p.max_flight_days,
      maint_buffer: p.maint_buffer,
      spare_buffer: p.spare_buffer,
      capex_platform_EUR: p.capex_platform_EUR,
      life_platform_days: p.life_platform_days,
    };
    const updated = upsert(platPresets, item);
    setPlatPresets(updated);
    setPlatSel(id);
    setPlatName("");
    saveJSON(PLAT_KEY, updated);
  };
  const removePlat = () => {
    if (!platSel) return;
    const updated = removeById(platPresets, platSel);
    setPlatPresets(updated);
    setPlatSel(updated[0]?.id || "");
    saveJSON(PLAT_KEY, updated);
  };

  /* ====== NUOVI PRESET: Payload ====== */
  const [payPresets, setPayPresets] = useState(loadJSON(PAY_KEY, []));
  const [paySel, setPaySel] = useState(payPresets[0]?.id || "");
  const [payName, setPayName] = useState("");

  const loadPayPreset = () => {
    const pr = payPresets.find(x => x.id === paySel);
    if (!pr) return;
    setP(prev => ({
      ...prev,
      swath_km: pr.swath_km ?? prev.swath_km,
      ground_speed_kmh: pr.ground_speed_kmh ?? prev.ground_speed_kmh,
      duty: pr.duty ?? prev.duty,
      cov_eff: pr.cov_eff ?? prev.cov_eff,
      overlap: pr.overlap ?? prev.overlap,
      turn_radius_km: pr.turn_radius_km ?? prev.turn_radius_km,
      eta_nav: pr.eta_nav ?? prev.eta_nav,
      capex_payload_EUR: pr.capex_payload_EUR ?? prev.capex_payload_EUR,
      life_payload_days: pr.life_payload_days ?? prev.life_payload_days,
      consumables_per_mission: pr.consumables_per_mission ?? prev.consumables_per_mission,
    }));
  };
  const savePayPreset = () => {
    const name = (payName || "Payload preset").trim();
    const id = slug(name);
    const item = {
      id, name,
      swath_km: p.swath_km,
      ground_speed_kmh: p.ground_speed_kmh,
      duty: p.duty,
      cov_eff: p.cov_eff,
      overlap: p.overlap,
      turn_radius_km: p.turn_radius_km,
      eta_nav: p.eta_nav,
      capex_payload_EUR: p.capex_payload_EUR,
      life_payload_days: p.life_payload_days,
      consumables_per_mission: p.consumables_per_mission,
    };
    const updated = upsert(payPresets, item);
    setPayPresets(updated);
    setPaySel(id);
    setPayName("");
    saveJSON(PAY_KEY, updated);
  };
  const removePay = () => {
    if (!paySel) return;
    const updated = removeById(payPresets, paySel);
    setPayPresets(updated);
    setPaySel(updated[0]?.id || "");
    saveJSON(PAY_KEY, updated);
  };

  // Wizard & results highlight
  const [currentStep, setCurrentStep] = useState(0);
  const resultsRef = useRef(null);
  const [flashResults, setFlashResults] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Enter") {
        setCurrentStep(4);
        setTimeout(() => {
          resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          setFlashResults(true);
          setTimeout(() => setFlashResults(false), 1200);
        }, 50);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ===== Storico state ===== */
  const [history, setHistory] = useState(loadHistory());
  useEffect(() => saveHistory(history), [history]);

  const saveQuote = () => {
    // Prezzo che salviamo: annuo (SaaS) o TOTALE scelto (Tasking)
    const priceChosen = p.mode === "saas" ? m.PriceGM : t.Ptot_final;
    const total_cost = p.mode === "saas" ? m.Ann : t.tot;
    const GM_prop = p.mode === "saas" ? m.GM : t.GMm_final;

    const id = `q_${Date.now()}`;
    const entry = {
      id, ts: Date.now(),
      client_name: p.client_name || "Cliente",
      aoi_name: p.aoi_name || "AOI",
      mode: p.mode, platform: p.platform, mission_profile: p.mission_profile,
      missions_count: missionsCount,
      aoi_km2: p.aoi_km2, revisit_min: p.revisit_min, Hh: m.Hh, n: m.n,
      price_target: priceChosen,
      total_cost,
      GM_prop,
      Cmis: p.mode==="saas"?m.Cmis:t.Cmis,
      inputs: { ...p },
      results: { saas: p.mode==="saas"?m:null, tasking: p.mode==="tasking"?t:null }
    };
    setHistory(prev=>[entry, ...prev].slice(0,500));
    setCurrentStep(5);
  };
  const loadQuoteIntoForm = (entry) => { if (entry?.inputs){ setP(entry.inputs); setCurrentStep(4); setTimeout(()=>resultsRef.current?.scrollIntoView({behavior:"smooth"}),50);} };
  const removeQuote = (id) => setHistory(prev=>prev.filter(q=>q.id!==id));
  const clearAllQuotes = () => { if (confirm("Svuotare tutto lo storico preventivi?")) setHistory([]); };
  const stats = useMemo(()=>quickStats(history),[history]);

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0b1220] to-[#05070c] text-slate-100">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header + Stepper */}
        <header className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="text-[#5fb1ff]">Involve Space</span> — Planner SaaS / Tasking
            </h1>
            <div className="flex items-center gap-2 text-sm">
              <span className="opacity-70">Mode <InfoTip id="mode" /></span>
              <label className="px-3 py-1 rounded-lg bg-white/5 border border-white/10">
                <input type="radio" className="mr-2" checked={p.mode === "saas"} onChange={() => set("mode", "saas")} />
                SaaS (annuale)
              </label>
              <label className="px-3 py-1 rounded-lg bg-white/5 border border-white/10">
                <input type="radio" className="mr-2" checked={p.mode === "tasking"} onChange={() => set("mode", "tasking")} />
                Tasking (per missione)
              </label>
            </div>
          </div>

          <nav className="w-full overflow-x-auto">
            <ol className="flex items-center gap-2 min-w-max">
              {STEPS.map((s, i) => (
                <li key={s.key}>
                  <button
                    onClick={() => setCurrentStep(i)}
                    className={`px-3 py-1.5 rounded-full text-sm border ${i===currentStep ? "bg-[#5fb1ff]/20 border-[#5fb1ff] text-[#9ed1ff]" : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"}`}
                  >
                    {i + 1}. {s.title}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </header>

        {/* Layout a step */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* COL INPUT */}
          <div className="lg:col-span-2 space-y-6">
            {/* STEP 0 — AOI & Servizio */}
            {currentStep === 0 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">AOI & Servizio</h2>

                {/* Cliente & AOI name */}
                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-slate-300">Cliente</label>
                    <input className="w-full border border-white/10 bg-white/5 text-slate-100 rounded-lg px-2 py-2"
                      value={p.client_name} onChange={(e)=>set("client_name",e.target.value)} placeholder="Nome cliente" />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-300">Nome AOI</label>
                    <input className="w-full border border-white/10 bg-white/5 text-slate-100 rounded-lg px-2 py-2"
                      value={p.aoi_name} onChange={(e)=>set("aoi_name",e.target.value)} placeholder="Es. Milano prov." />
                  </div>
                </div>

                {/* AOI preset */}
                <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                  <div className="text-sm font-medium mb-2 text-slate-200">AOI predefinite</div>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <select className="md:col-span-6 border border-white/10 rounded px-2 py-2 bg-white/5"
                            value={selectedPresetId} onChange={(e)=>setSelectedPresetId(e.target.value)}>
                      <option value="">— seleziona preset —</option>
                      {presets.map((pr) => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                    </select>
                    <Button variant="secondary" className="md:col-span-2 py-2 bg-white/10 hover:bg-white/20 whitespace-nowrap" onClick={loadPreset}>Carica</Button>
                    <input className="md:col-span-3 border border-white/10 rounded px-2 py-2 bg-white/5"
                           placeholder="Nome nuovo preset" value={presetName} onChange={(e)=>setPresetName(e.target.value)} />
                    <Button className="md:col-span-2 py-2 whitespace-nowrap" title="Salva l'AOI attuale come preset" onClick={saveCurrentAsPreset}>Salva</Button>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 items-center">
                    <Button variant="outline" className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={deleteSelectedPreset}>Elimina selezionato</Button>
                    <span className="text-slate-400">I preset sono salvati nel tuo browser.</span>
                  </div>
                </div>

                <div className="flex gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={p.aoiType === "areal"} onChange={() => set("aoiType", "areal")} /> Areale
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={p.aoiType === "corridor"} onChange={() => set("aoiType", "corridor")} /> Corridoio
                  </label>
                </div>

                <label className="block text-sm text-slate-300">Area km² <InfoTip id="aoi_km2" /></label>
                <Num v={p.aoi_km2} on={(v) => set("aoi_km2", v)} />
                {p.aoiType === "areal" ? (
                  <>
                    <label className="block text-sm mt-2 text-slate-300">Larghezza km <span className="opacity-60">(vuoto = √A)</span> <InfoTip id="aoi_width_km" /></label>
                    <Num v={p.aoi_width_km} on={(v) => set("aoi_width_km", v)} />
                  </>
                ) : (
                  <>
                    <label className="block text-sm mt-2 text-slate-300">Corridor width km <InfoTip id="corridor_width_km" /></label>
                    <Num v={p.corridor_width_km} on={(v) => set("corridor_width_km", v)} />
                  </>
                )}
                <label className="block text-sm mt-2 text-slate-300">Revisita min <InfoTip id="revisit_min" /></label>
                <Num v={p.revisit_min} on={(v) => set("revisit_min", v)} />
              </section>
            )}

            {/* STEP 1 — Piattaforma & Ops */}
            {currentStep === 1 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Piattaforma & Ops</h2>

                {/* Preset piattaforma */}
                <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                  <div className="text-sm font-medium mb-2 text-slate-200">Preset piattaforma</div>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <select className="md:col-span-6 border border-white/10 rounded px-2 py-2 bg-white/5"
                            value={platSel} onChange={(e)=>setPlatSel(e.target.value)}>
                      <option value="">— seleziona preset —</option>
                      {platPresets.map(pr => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                    </select>
                    <Button variant="secondary" className="md:col-span-2 py-2 bg-white/10 hover:bg-white/20" onClick={loadPlatPreset}>Carica</Button>
                    <input className="md:col-span-3 border border-white/10 rounded px-2 py-2 bg-white/5"
                           placeholder="Nome preset (es. Stratostats v2)" value={platName} onChange={(e)=>setPlatName(e.target.value)} />
                    <Button className="md:col-span-2 py-2" onClick={savePlatPreset}>Salva</Button>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 items-center">
                    <Button variant="outline" className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={removePlat}>Elimina selezionato</Button>
                    <span className="text-slate-400">Salvato in locale nel browser.</span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-3 mb-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={p.platform === "stats"} onChange={() => set("platform", "stats")} />
                    Stratostats <InfoTip id="platform" />
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={p.platform === "relay"} onChange={() => set("platform", "relay")} />
                    Stratorelay <InfoTip id="platform" />
                  </label>
                </div>

                {p.platform === "relay" ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="block text-sm text-slate-300">Durata volo (h) <InfoTip id="mission_days" /></label><Num v={p.relay_hours_h} on={(v)=>set("relay_hours_h",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Turnaround gg <InfoTip id="turnaround_days" /></label>
                        <input disabled className="w-full border border-white/10 bg-white/5 text-slate-400 rounded-lg px-2 py-2" value="—" />
                      </div>
                    </div>
                    <p className="text-xs text-slate-400 mt-2">Stratorelay non può fare revisite con singola piattaforma: revisit più strette ⇒ più <b>lanci</b>.</p>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="block text-sm text-slate-300">Durata gg <InfoTip id="mission_days" /></label><Num v={p.mission_days} on={(v)=>set("mission_days",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Turnaround gg <InfoTip id="turnaround_days" /></label><Num v={p.turnaround_days} on={(v)=>set("turnaround_days",v)} /></div>
                      <div><label className="block text-sm text-slate-300">MTBF h <InfoTip id="mtbf_h" /></label><Num v={p.mtbf_h} on={(v)=>set("mtbf_h",v)} /></div>
                      <div><label className="block text-sm text-slate-300">MTTR h <InfoTip id="mttr_h" /></label><Num v={p.mttr_h} on={(v)=>set("mttr_h",v)} /></div>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-2">
                      <div><label className="block text-sm text-slate-300">Max flight days <InfoTip id="max_flight_days" /></label><Num v={p.max_flight_days} on={(v)=>set("max_flight_days",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Maint buffer <InfoTip id="maint_buffer" /></label><Num v={p.maint_buffer} on={(v)=>set("maint_buffer",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Spare buffer <InfoTip id="spare_buffer" /></label><Num v={p.spare_buffer} on={(v)=>set("spare_buffer",v)} /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mt-2">
                      <div><label className="block text-sm text-slate-300">CAPEX plat <InfoTip id="capex_platform_EUR" /></label><Num v={p.capex_platform_EUR} on={(v)=>set("capex_platform_EUR",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Vita plat (gg) <InfoTip id="life_platform_days" /></label><Num v={p.life_platform_days} on={(v)=>set("life_platform_days",v)} /></div>
                    </div>
                  </>
                )}
              </section>
            )}

            {/* STEP 2 — Sensore & Navigazione */}
            {currentStep === 2 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Sensore & Navigazione</h2>

                {/* Preset payload */}
                <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                  <div className="text-sm font-medium mb-2 text-slate-200">Preset payload</div>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <select className="md:col-span-6 border border-white/10 rounded px-2 py-2 bg-white/5"
                            value={paySel} onChange={(e)=>setPaySel(e.target.value)}>
                      <option value="">— seleziona preset —</option>
                      {payPresets.map(pr => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                    </select>
                    <Button variant="secondary" className="md:col-span-2 py-2 bg-white/10 hover:bg-white/20" onClick={loadPayPreset}>Carica</Button>
                    <input className="md:col-span-3 border border-white/10 rounded px-2 py-2 bg-white/5"
                           placeholder="Nome preset (es. SAR v1 ECHOES)" value={payName} onChange={(e)=>setPayName(e.target.value)} />
                    <Button className="md:col-span-2 py-2" onClick={savePayPreset}>Salva</Button>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 items-center">
                    <Button variant="outline" className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={removePay}>Elimina selezionato</Button>
                    <span className="text-slate-400">Salvato in locale nel browser.</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-sm text-slate-300">Swath km <InfoTip id="swath_km" /></label><Num v={p.swath_km} on={(v)=>set("swath_km",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Vel km/h <InfoTip id="ground_speed_kmh" /></label><Num v={p.ground_speed_kmh} on={(v)=>set("ground_speed_kmh",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Duty <InfoTip id="duty" /></label><Num v={p.duty} on={(v)=>set("duty",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Eff. copertura <InfoTip id="cov_eff" /></label><Num v={p.cov_eff} on={(v)=>set("cov_eff",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Overlap ρ <InfoTip id="overlap" /></label><Num v={p.overlap} on={(v)=>set("overlap",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Raggio virata km <InfoTip id="turn_radius_km" /></label><Num v={p.turn_radius_km} on={(v)=>set("turn_radius_km",v)} /></div>
                  <div><label className="block text-sm text-slate-300">η nav <InfoTip id="eta_nav" /></label><Num v={p.eta_nav} on={(v)=>set("eta_nav",v)} /></div>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div><label className="block text-sm text-slate-300">CAPEX payload <InfoTip id="capex_payload_EUR" /></label><Num v={p.capex_payload_EUR} on={(v)=>set("capex_payload_EUR",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Vita payload (gg) <InfoTip id="life_payload_days" /></label><Num v={p.life_payload_days} on={(v)=>set("life_payload_days",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Consumabili <InfoTip id="consumables_per_mission" /></label><Num v={p.consumables_per_mission} on={(v)=>set("consumables_per_mission",v)} /></div>
                </div>
              </section>
            )}

            {/* STEP 3 — Prezzi & Target */}
            {currentStep === 3 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Prezzi & Target</h2>

                <div className="text-sm text-slate-300">
                  {p.mode === "saas" ? (
                    <div className="grid md:grid-cols-3 gap-3 items-end">
                      <div className="md:col-span-2">SaaS calcola capacità e costi annuali (senza stagionalità).</div>
                      <div>
                        <label className="block text-sm text-slate-300">Prezzo proposto (annuo)</label>
                        <Num v={p.proposed_annual_price_EUR} on={(v)=>set("proposed_annual_price_EUR",v)} />
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-3 items-end">
                      <div className="col-span-1"><label className="block text-sm text-slate-300"># {p.platform==='relay'?'lanci':'missioni'} (manuale)</label><Num v={missionsCount} on={(v)=>set("missions_count",v)} /></div>
                      <div className="col-span-1"><label className="block text-sm text-slate-300">Profilo missione</label>
                        <select className="w-full border border-white/10 rounded px-2 py-2 bg-white/5" value={p.mission_profile} onChange={(e)=>set("mission_profile",e.target.value)}>
                          {Object.entries(PROFILES).map(([k,x])=> <option key={k} value={k}>{x.name}</option>)}
                        </select>
                      </div>
                      <div className="col-span-1"><label className="block text-sm text-slate-300">Prezzo proposto / {p.platform==='relay'?'lancio':'missione'}</label><Num v={p.proposed_price_per_mission_EUR} on={(v)=>set("proposed_price_per_mission_EUR",v)} /></div>
                    </div>
                  )}
                </div>

                <div className="grid md:grid-cols-3 gap-3">
                  <div><label className="block text-sm text-slate-300">Cf {p.platform==='relay'?'lancio':'missione'} <InfoTip id="Cf_mission" /></label><Num v={p.Cf_mission} on={(v)=>set("Cf_mission",v)} /></div>
                  <div><label className="block text-sm text-slate-300">€/h (Ch) <InfoTip id="Ch_hour" /></label><Num v={p.Ch_hour} on={(v)=>set("Ch_hour",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Cloud annuo <InfoTip id="annual_cloud_costs" /></label><Num v={p.annual_cloud_costs} on={(v)=>set("annual_cloud_costs",v)} /></div>
                  <div><label className="block text-sm text-slate-300">GM target % <InfoTip id="target_gm" /></label><Num v={p.target_gm} on={(v)=>set("target_gm",v)} /></div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-200" onClick={()=>setCurrentStep((s)=>Math.max(0,s-1))}>← Indietro</button>
                  <div className="flex gap-2">
                    <button className="px-4 py-1.5 rounded-lg bg-[#5fb1ff]/20 border border-[#5fb1ff] text-[#9ed1ff]" onClick={()=>setCurrentStep((s)=>Math.min(4,s+1))}>Avanti →</button>
                    <button className="px-4 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-400 text-emerald-200" onClick={()=>{setCurrentStep(4); setTimeout(()=>{resultsRef.current?.scrollIntoView({behavior:"smooth",block:"start"});},50);}}>Calcola (Invio)</button>
                  </div>
                </div>
              </section>
            )}

            {/* step navigation for 0/1/2 */}
            {currentStep < 3 && (
              <div className="flex items-center justify-between">
                <button className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-200 disabled:opacity-40" onClick={()=>setCurrentStep((s)=>Math.max(0,s-1))} disabled={currentStep===0}>← Indietro</button>
                <div className="flex gap-2">
                  <button className="px-4 py-1.5 rounded-lg bg-[#5fb1ff]/20 border border-[#5fb1ff] text-[#9ed1ff]" onClick={()=>setCurrentStep((s)=>Math.min(3,s+1))}>Avanti →</button>
                  <button className="px-4 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-400 text-emerald-200" onClick={()=>{setCurrentStep(4); setTimeout(()=>{resultsRef.current?.scrollIntoView({behavior:"smooth",block:"start"});},50);}}>Calcola (Invio)</button>
                </div>
              </div>
            )}
          </div>

          {/* COL RISULTATI */}
          <section ref={resultsRef} className={`bg-white/5 border border-white/10 rounded-2xl shadow-xl p-4 space-y-4 transition ${flashResults ? "ring-4 ring-emerald-400/60" : "ring-0"}`}>
            <CardHeader className="px-0 pt-0">
              <CardTitle className={p.mode === "saas" ? "text-[#9ed1ff]" : "text-emerald-300"}>
                {p.mode === "saas"
                  ? `Risultati — SaaS (annuale) · ${p.platform === "relay" ? "Stratorelay" : "Stratostats"}`
                  : `Risultati — Tasking (per ${p.platform === "relay" ? "lancio" : "missione"})`}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0 space-y-2">
              {p.mode === "saas" ? (
                <>
                  <Row l="T_sweep / T_repos / T_cycle" info="aoi_km2">{N(m.Ts,0)} / {N(m.Tr,0)} / <b>{N(m.Tc,0)} min</b></Row>
                  <Row l="# strisce (n)" info="overlap">{m.n}</Row>
                  <Row l="Slack (R - T_cycle)"><span className={m.slack>=0?"text-emerald-400":"text-red-400"}>{N(m.slack,0)} min {m.slack>=0?"(OK)":"(KO)"}</span></Row>
                  <div className="border-t border-white/10"/>
                  <Row l={p.platform==='relay'?"Lanci/anno (base/tot)":"Voli/anno (base/tot)"}>{m.Fb} / <b>{m.Ft}</b></Row>
                  <Row l="Revisite/anno" info="revisit_min">{m.revisitsY}</Row>
                  {p.platform!=='relay' && (<><Row l="Voli/pf/anno">{m.Fpp}</Row><Row l="Piattaforme (finale)">{m.P}</Row></>)}
                  <div className="border-t border-white/10"/>
                  <Row l={`Costo ${p.platform==='relay'?'lancio':'missione'} (ops)`}>{EUR(m.Cmis)}</Row>
                  <Row l="Costo annuo AOI">{EUR(m.Ann)}</Row>
                  <Row l="€/km² per revisita">{EUR(m.EURkm2rev,2)}</Row>
                  <Row l="€/km² annuo">{EUR(m.EURkm2y,2)}</Row>
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-400/40 p-3">
                    <div className="text-xs uppercase tracking-wide text-emerald-300/80">Prezzo (GM target)</div>
                    <div className="text-2xl font-semibold text-emerald-200">{EUR(m.PriceGM)}</div>
                  </div>
                  {m.GM!=null && <Row l="GM su prezzo proposto">{N(m.GM*100,1)}%</Row>}
                </>
              ) : (
                <>
                  <Row l="Profilo">{PROFILES[p.mission_profile].name}</Row>
                  <Row l={`Durata ${p.platform==='relay'?'lancio':'missione'} eff.`}>{N(t.D,2)} gg ({N(t.H,0)} h)</Row>
                  <div className="border-t border-white/10"/>
                  <Row l={`Costo per ${p.platform==='relay'?'lancio':'missione'}`}>{EUR(t.Cmis)}</Row>

                  {/* Prezzo a GM target */}
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-400/40 p-3">
                    <div className="text-xs uppercase tracking-wide text-emerald-300/80">Prezzo {p.platform==='relay'?'lancio':'missione'} (GM target)</div>
                    <div className="text-2xl font-semibold text-emerald-200">{EUR(t.pricePerMissionGM)}</div>
                  </div>

                  {/* Se inserito un prezzo manuale, mostralo e usalo nei totali */}
                  {t.hasUserPrice && (
                    <>
                      <Row l={`Prezzo proposto / ${p.platform==='relay'?'lancio':'missione'}`}>{EUR(t.userPm)}</Row>
                      <Row l={`GM su prezzo proposto/${p.platform==='relay'?'lancio':'missione'}`}>{N(t.GMm_user*100,1)}%</Row>
                    </>
                  )}

                  <div className="border-t border-white/10"/>
                  <Row l={`# ${p.platform==='relay'?'lanci':'missioni'}`}>{missionsCount}</Row>

                  {/* Totali: prezzo scelto (manuale se presente, altrimenti GM target) + costo totale */}
                  <Row l="Prezzo totale (scelto)"><b>{EUR(t.Ptot_final)}</b></Row>
                  <Row l="Costo totale"><b>{EUR(t.tot)}</b></Row>
                  <Row l="GM su totale scelto">{N(t.GMtot_final*100,1)}%</Row>
                </>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="bg-emerald-500/20 border border-emerald-400 text-emerald-200" onClick={saveQuote}>Salva preventivo nello storico</Button>
                <Button className="bg-white/10 border border-white/20 text-slate-200" onClick={()=>setCurrentStep(5)}>Vai a Storico & Analisi</Button>
              </div>
            </CardContent>
          </section>
        </div>

        {/* STEP 5 — Storico & Analisi */}
        {currentStep === 5 && (
          <section className="bg-white/5 border border-white/10 rounded-2xl shadow-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[#9ed1ff] font-medium">Storico preventivi & analisi</h2>
              <div className="flex gap-2">
                <Button className="bg-white/10 border border-white/20" onClick={() => {
                  const csv = toCSV(history);
                  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a"); a.href = url; a.download = "preventivi_involve_space.csv"; a.click(); URL.revokeObjectURL(url);
                }}>Esporta CSV</Button>
                <Button className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={clearAllQuotes}>Svuota tutto</Button>
              </div>
            </div>

            <div className="grid sm:grid-cols-4 gap-3">
              <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70"># Preventivi</div><div className="text-xl font-semibold">{stats.count}</div></div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70">Prezzo target medio</div><div className="text-xl font-semibold">{EUR(stats.avgPrice || 0)}</div></div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70">Costo medio</div><div className="text-xl font-semibold">{EUR(stats.avgCost || 0)}</div></div>
              <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70">GM medio (su proposti)</div><div className="text-xl font-semibold">{N((stats.avgGM || 0) * 100, 1)}%</div></div>
            </div>

            <div className="overflow-auto rounded-xl border border-white/10">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="bg-white/5">
                  <tr className="text-left">
                    <th className="px-3 py-2">Data</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">AOI</th>
                    <th className="px-3 py-2">Mode</th><th className="px-3 py-2">Piattaforma</th><th className="px-3 py-2">Profilo</th>
                    <th className="px-3 py-2">Area km²</th><th className="px-3 py-2">Revisita (min)</th><th className="px-3 py-2">H missione</th>
                    <th className="px-3 py-2"># strisce</th><th className="px-3 py-2">Costo totale</th><th className="px-3 py-2">Prezzo target</th>
                    <th className="px-3 py-2">GM proposto</th><th className="px-3 py-2">Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr><td colSpan={14} className="px-3 py-4 text-center text-slate-400">Nessun preventivo salvato.</td></tr>
                  ) : history.map(q=>(
                    <tr key={q.id} className="border-t border-white/10">
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(q.ts)}</td>
                      <td className="px-3 py-2">{q.client_name}</td>
                      <td className="px-3 py-2">{q.aoi_name}</td>
                      <td className="px-3 py-2">{q.mode}</td>
                      <td className="px-3 py-2">{q.platform}</td>
                      <td className="px-3 py-2">{q.mission_profile}</td>
                      <td className="px-3 py-2">{N(q.aoi_km2,1)}</td>
                      <td className="px-3 py-2">{N(q.revisit_min,0)}</td>
                      <td className="px-3 py-2">{N(q.Hh,0)}</td>
                      <td className="px-3 py-2">{q.n}</td>
                      <td className="px-3 py-2">{EUR(q.total_cost || 0)}</td>
                      <td className="px-3 py-2">{EUR(q.price_target || 0)}</td>
                      <td className="px-3 py-2">{q.GM_prop!=null ? `${N(q.GM_prop*100,1)}%` : "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-2">
                          <Button className="bg-white/10 border border-white/20 text-slate-200" onClick={()=>loadQuoteIntoForm(q)}>Carica</Button>
                          <Button className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={()=>removeQuote(q.id)}>Elimina</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              {Object.entries(stats.byPlatform).map(([plat, v]) => (
                <div key={plat} className="rounded-xl bg-white/5 border border-white/10 p-3">
                  <div className="text-xs opacity-70 mb-1">Piattaforma: {plat}</div>
                  <div className="text-sm"># Preventivi: <b>{v.count}</b></div>
                  <div className="text-sm">Prezzo medio: <b>{EUR(v.price / v.count || 0)}</b></div>
                  <div className="text-sm">Costo medio: <b>{EUR(v.cost / v.count || 0)}</b></div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
