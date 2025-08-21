import React, { useMemo, useState, useEffect, useRef } from "react";
import { loadPresets, upsertPreset, removePreset, slug } from "./presets.js";
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card";
import { Button } from "./components/ui/button";

/* ====================== Utils ====================== */
const N = (n, d = 2) =>
  new Intl.NumberFormat("en-GB", { maximumFractionDigits: d }).format(
    isFinite(n) ? n : 0
  );
const EUR = (n, d = 0) =>
  new Intl.NumberFormat("en-GB", {
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
  new Date(ts).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });

/* ====================== Tasking profiles ====================== */
const PROFILES = {
  standard: { name: "Standard", D: 1, Cf: 1, Ch: 1, Cons: 1 },
  long: { name: "Long", D: 1.5, Cf: 1.1, Ch: 1, Cons: 1.2 },
  express: { name: "Express", D: 0.7, Cf: 1.15, Ch: 1.15, Cons: 1 },
};

/* ====================== Default params ====================== */
const DEF = {
  mode: "saas",                // "saas" | "tasking"
  platform: "stats",           // "stats" | "relay"
  relay_hours_h: 6,

  // AOI
  aoiType: "areal",
  aoi_km2: 181.8,
  aoi_width_km: null,
  corridor_width_km: 0.8,

  // Mission
  revisit_min: 1440,           // SaaS
  missions_count: 6,           // Tasking
  mission_profile: "standard",
  proposed_price_per_mission_EUR: "",

  // Ops
  mission_days: 7,
  turnaround_days: 1,

  // Payload & navigation
  swath_km: 7,
  ground_speed_kmh: 40,
  duty: 0.75,
  cov_eff: 0.5,
  overlap: 0.2,
  turn_radius_km: 5,
  eta_nav: 0.8,

  // Reliability & fleet
  mtbf_h: 500,
  mttr_h: 20,
  max_flight_days: 200,
  maint_buffer: 0.25,
  spare_buffer: 0.15,

  // Costs
  Cf_mission: 2500,
  Ch_hour: 25,
  capex_platform_EUR: 20000,
  life_platform_days: 800,
  capex_payload_EUR: 90000,
  life_payload_days: 1200,
  consumables_per_mission: 500,
  annual_cloud_costs: 12000,

  // Pricing
  target_gm: 0.5,
  proposed_annual_price_EUR: "",

  // Meta
  client_name: "Client",
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
  const Kyear = A * revisitsY;               // km² of revisit coverage in one year
  const Kmis = covRate * Math.max(Hh, 1e-6); // km² per mission

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

  // Costs normalized
  const EURkm2_per_revisit = Ann / Math.max(Kyear, 1); // cost per km² per revisit
  const EURkm2_year = Ann / Math.max(A, 1);            // cost per km² per year

  // Price at GM target and chosen price (manual if provided)
  const PriceGM = Ann / Math.max(1 - pdec(p.target_gm, DEF.target_gm), 0.01);
  let GM = null;
  let PriceAnnualChosen = PriceGM;
  if (p.proposed_annual_price_EUR !== "" && !isNaN(+p.proposed_annual_price_EUR)) {
    const Puser = Math.max(+p.proposed_annual_price_EUR, 0.01);
    GM = (Puser - Ann) / Puser;
    PriceAnnualChosen = Puser;
  }

  // Chosen price normalized
  const PricePerKm2_year = PriceAnnualChosen / Math.max(A, 1);
  const PricePerKm2_per_revisit = PriceAnnualChosen / Math.max(Kyear, 1);
  const PricePerMission_target = Cmis / Math.max(1 - pdec(p.target_gm, DEF.target_gm), 0.01);

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
    Kmis,
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
    EURkm2_per_revisit,
    EURkm2_year,
    PriceGM,
    PriceAnnualChosen,
    PricePerKm2_year,
    PricePerKm2_per_revisit,
    PricePerMission_target,
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

  // km² per mission for per-km² pricing
  const covRate = pdec(p.swath_km, DEF.swath_km) * pdec(p.ground_speed_kmh, DEF.ground_speed_kmh) * pdec(p.duty, DEF.duty) * pdec(p.cov_eff, DEF.cov_eff);
  const Kmis = covRate * H;

  // Price at GM target
  const gmTarget = pdec(p.target_gm, DEF.target_gm);
  const pricePerMissionGM = Cmis / Math.max(1 - gmTarget, 0.01);
  const totalPriceGM = pricePerMissionGM * m;

  // Manual proposal
  const userPmValid = p.proposed_price_per_mission_EUR !== "" && isFinite(+p.proposed_price_per_mission_EUR);
  const userPm = userPmValid ? Math.max(+p.proposed_price_per_mission_EUR, 0.01) : null;
  const userTotal = userPmValid ? userPm * m : null;
  const GMm_user = userPmValid ? (userPm - Cmis) / userPm : null;
  const GMtot_user = userPmValid ? (userTotal - tot) / userTotal : null;

  // Final choice
  const Pm_final = userPmValid ? userPm : pricePerMissionGM;
  const Ptot_final = Pm_final * m;
  const GMm_final = (Pm_final - Cmis) / Pm_final;
  const GMtot_final = (Ptot_final - tot) / Ptot_final;

  // Per-km² per mission
  const pricePerKm2 = Pm_final / Math.max(Kmis, 1e-6);
  const costPerKm2 = Cmis / Math.max(Kmis, 1e-6);

  return {
    isRelay,
    pr,
    D,
    H,
    Cmis,
    Kmis,
    tot,
    pricePerMissionGM,
    totalPriceGM,
    userPm,
    userTotal,
    GMm_user,
    GMtot_user,
    Pm_final,
    Ptot_final,
    GMm_final,
    GMtot_final,
    pricePerKm2,
    costPerKm2,
    hasUserPrice: userPmValid,
  };
}

/* ====================== Tooltips (ⓘ) ====================== */
const INFO = {
  mode: { t: "Mode", d: "SaaS (annual) or Tasking (per mission/launch).", f: "Target price = cost/(1−GM)" },
  platform: { t: "Platform", d: "Stratostats (fleet) or Stratorelay (launches).", f: "Capacity = w·v·d·c·H" },
  aoi_km2: { t: "AOI area", d: "Surface to cover (km²).", f: "T_sweep = A/(w·v·d·c)" },
  aoi_width_km: { t: "AOI width", d: "Empty = √A.", f: "n ≈ width/(swath·(1−ρ))" },
  corridor_width_km: { t: "Corridor width", d: "Only for Corridor mode.", f: "n = ceil(W/(swath·(1−ρ)))" },
  revisit_min: { t: "Revisit", d: "Minimum interval between passes (SaaS).", f: "Revisits/year = 525600/R" },
  mission_days: { t: "Mission duration", d: "Active mission days.", f: "H = D·24" },
  turnaround_days: { t: "Turnaround", d: "Gap between missions (Stats).", f: "Flights/pf/year ≈ usable_days·Aavail/(D+turnaround)" },
  swath_km: { t: "Swath", d: "Imaging strip width.", f: "Hourly capacity = w·v·d·c" },
  ground_speed_kmh: { t: "Ground speed", d: "Average speed over ground.", f: "Hourly capacity = w·v·d·c" },
  duty: { t: "Duty", d: "Effective useful fraction of time.", f: "Hourly capacity = w·v·d·c" },
  cov_eff: { t: "Coverage efficiency", d: "Geometric/operational losses.", f: "Hourly capacity = w·v·d·c" },
  overlap: { t: "Overlap ρ", d: "Overlap between adjacent strips.", f: "n increases if ρ increases" },
  turn_radius_km: { t: "Turn radius", d: "Influences reposition time.", f: "T_repos ≈ (n·π·r)/(v·η)" },
  eta_nav: { t: "Navigation efficiency", d: "Efficiency for transit and repositioning.", f: "T_repos ≈ (n·π·r)/(v·η)" },
  mtbf_h: { t: "MTBF", d: "Mean time between failures (h).", f: "Aavail ≈ MTBF/(MTBF+MTTR)" },
  mttr_h: { t: "MTTR", d: "Mean time to repair (h).", f: "Aavail ≈ MTBF/(MTBF+MTTR)" },
  max_flight_days: { t: "Max flight days", d: "Annual flyable budget.", f: "Flights/pf/year ≈ usable_days·Aavail/(D+turnaround)" },
  maint_buffer: { t: "Maintenance buffer", d: "Share of non-operational days.", f: "usable_days = max_flight_days·(1−buffer)" },
  spare_buffer: { t: "Spare buffer", d: "Margin on platform count.", f: "P = ceil(P0·(1+buffer))" },
  Cf_mission: { t: "Fixed cost", d: "Direct cost per mission/launch.", f: "C_mis = Cf + Ch·H + amort. + consumables" },
  Ch_hour: { t: "€/h", d: "Hourly ops cost.", f: "C_mis includes Ch·H" },
  consumables_per_mission: { t: "Consumables", d: "Per mission/launch consumables.", f: "Included in C_mis" },
  capex_platform_EUR: { t: "Platform CAPEX", d: "Platform acquisition cost.", f: "Amort. = CAPEX/life_days" },
  life_platform_days: { t: "Platform life (days)", d: "Useful life in days.", f: "Amort. = CAPEX/life_days" },
  capex_payload_EUR: { t: "Payload CAPEX", d: "Sensor cost.", f: "Amort. = CAPEX/life_days" },
  life_payload_days: { t: "Payload life (days)", d: "Useful life in days.", f: "Amort. = CAPEX/life_days" },
  annual_cloud_costs: { t: "Annual cloud costs", d: "Storage/compute.", f: "Annual cost = Ft·C_mis + cloud" },
  target_gm: { t: "Target GM", d: "Desired gross margin.", f: "Price_target = cost/(1−GM)" },
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
        <div role="dialog" aria-label={i.t || "Information"}
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

/* ====================== Wizard steps (English) ====================== */
const STEPS = [
  { key: "service", title: "Select Service" },           // SaaS or Tasking
  { key: "platform", title: "Platform Type" },           // Stratostats or Stratorelay
  { key: "plat_params", title: "Platform Parameters" },  // CAPEX/reliability/ops/costs
  { key: "payload", title: "Payload & Navigation" },     // sensor params
  { key: "mission", title: "Mission Parameters" },       // revisit or #missions
  { key: "aoi", title: "AOI Selection" },                // AOI geometry
  { key: "summary", title: "Summary Sheet" },            // confirm & save
  { key: "history", title: "History" },                  // quotes list
];

/* ====================== Local presets ====================== */
const PLAT_KEY = "stratosar:plat-presets:v1";
const PAY_KEY  = "stratosar:payload-presets:v1";
const HIST_KEY = "stratosar:quotes:v3";

const loadJSON = (k, fb=[]) => { try { const r = localStorage.getItem(k); return r? JSON.parse(r): fb; } catch { return fb; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function upsertLocal(list, item) { const i = list.findIndex(x => x.id === item.id); if (i >= 0){ const copy=list.slice(); copy[i]=item; return copy; } return [...list, item]; }
function removeById(list, id) { return list.filter(x => x.id !== id); }

function loadHistory() { return loadJSON(HIST_KEY, []); }
function saveHistory(list) { saveJSON(HIST_KEY, list); }
function toCSV(rows) {
  const headers = [
    "id","ts","client","aoi","mode","platform","profile",
    "aoi_km2","revisit_min","missions_count",
    "cost_km2_per_revisit","cost_km2_year","cost_per_mission","cost_annual",
    "price_km2_per_revisit","price_km2_year","price_per_mission","price_annual",
    "GM"
  ];
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, fmtDate(r.ts), r.client_name, r.aoi_name, r.mode, r.platform, r.mission_profile,
      r.aoi_km2, r.revisit_min ?? "", r.missions_count ?? "",
      r.cost_km2_per_revisit ?? "", r.cost_km2_year ?? "", r.cost_per_mission ?? "", r.cost_annual ?? "",
      r.price_km2_per_revisit ?? "", r.price_km2_year ?? "", r.price_per_mission ?? "", r.price_annual ?? "",
      r.GM_prop ?? ""
    ].map(esc).join(","));
  }
  return lines.join("\n");
}

/* ====================== App ====================== */
export default function App() {
  const [p, setP] = useState(DEF);
  const set = (k, v) => setP((prev) => ({ ...prev, [k]: v }));

  const m = useMemo(() => compute(p), [p]);
  const missionsCount = Math.max(0, parseInt(p.missions_count || 0) || 0);
  const t = useMemo(() => taskingCalc(p, missionsCount, p.mission_profile), [p, missionsCount, p.mission_profile]);

  // AOI presets
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

  /* ====== Platform presets ====== */
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
      Cf_mission: pr.Cf_mission ?? prev.Cf_mission,
      Ch_hour: pr.Ch_hour ?? prev.Ch_hour,
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
      Cf_mission: p.Cf_mission,
      Ch_hour: p.Ch_hour,
    };
    const updated = upsertLocal(platPresets, item);
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

  /* ====== Payload presets ====== */
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
    const updated = upsertLocal(payPresets, item);
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

  // Wizard & nav
  const [currentStep, setCurrentStep] = useState(0);
  const resultsRef = useRef(null);
  const [flashResults, setFlashResults] = useState(false);
  const goToHistory = () => setCurrentStep(7);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Enter") {
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

  /* ===== History state ===== */
  const [history, setHistory] = useState(loadHistory());
  useEffect(() => saveHistory(history), [history]);

  // metrics for panels/history
  const metrics = useMemo(() => {
    if (p.mode === "saas") {
      const cost_km2_per_revisit = m.EURkm2_per_revisit;
      const cost_km2_year = m.EURkm2_year;
      const cost_per_mission = m.Cmis;
      const cost_annual = m.Ann;
      const price_annual = m.PriceAnnualChosen;
      const price_per_mission = m.PricePerMission_target;
      const price_km2_year = m.PricePerKm2_year;
      const price_km2_per_revisit = m.PricePerKm2_per_revisit;
      const GM_prop = m.GM;
      return { cost_km2_per_revisit, cost_km2_year, cost_per_mission, cost_annual, price_km2_per_revisit, price_km2_year, price_per_mission, price_annual, GM_prop };
    } else {
      const cost_km2_per_revisit = null; // not applicable
      const price_km2_per_revisit = null; // not applicable
      const cost_km2_year = t.costPerKm2; // per mission basis (naming kept distinct)
      const price_km2_year = t.pricePerKm2; // per mission basis
      const cost_per_mission = t.Cmis;
      const cost_annual = t.tot; // total of the mission batch
      const price_per_mission = t.Pm_final;
      const price_annual = t.Ptot_final; // total chosen
      const GM_prop = t.GMtot_final;
      return { cost_km2_per_revisit, cost_km2_year, cost_per_mission, cost_annual, price_km2_per_revisit, price_km2_year, price_per_mission, price_annual, GM_prop };
    }
  }, [p.mode, m, t]);

  const saveQuote = () => {
    const id = `q_${Date.now()}`;
    const entry = {
      id, ts: Date.now(),
      client_name: p.client_name || "Client",
      aoi_name: p.aoi_name || "AOI",
      mode: p.mode,
      platform: p.platform,
      mission_profile: p.mission_profile,
      missions_count: missionsCount,
      aoi_km2: p.aoi_km2,
      revisit_min: p.mode === "saas" ? p.revisit_min : "",
      // persisted metrics
      cost_km2_per_revisit: metrics.cost_km2_per_revisit,
      cost_km2_year: metrics.cost_km2_year,
      cost_per_mission: metrics.cost_per_mission,
      cost_annual: metrics.cost_annual,
      price_km2_per_revisit: metrics.price_km2_per_revisit,
      price_km2_year: metrics.price_km2_year,
      price_per_mission: metrics.price_per_mission,
      price_annual: metrics.price_annual,
      GM_prop: metrics.GM_prop,
      inputs: { ...p },
    };
    setHistory(prev => [entry, ...prev].slice(0, 1000));
    setCurrentStep(7);
  };

  const loadQuoteIntoForm = (entry) => { if (entry?.inputs){ setP(entry.inputs); setCurrentStep(6); } };
  const removeQuote = (id) => setHistory(prev=>prev.filter(q=>q.id!==id));
  const clearAllQuotes = () => { if (confirm("Clear all saved quotes?")) setHistory([]); };

  // quick stats
  const stats = useMemo(() => {
    if (history.length === 0) return { count: 0, avgPrice: 0, avgCost: 0, avgGM: 0 };
    const sum = history.reduce((acc, r) => {
      acc.price += +r.price_annual || 0;
      acc.cost += +r.cost_annual || 0;
      if (typeof r.GM_prop === "number") { acc.gm += r.GM_prop; acc.gmN += 1; }
      return acc;
    }, { price: 0, cost: 0, gm: 0, gmN: 0 });
    return {
      count: history.length,
      avgPrice: sum.price / history.length,
      avgCost: sum.cost / history.length,
      avgGM: sum.gmN ? sum.gm / sum.gmN : 0,
    };
  }, [history]);

  const next = () => setCurrentStep((s) => Math.min(STEPS.length - 1, s + 1));
  const prev = () => setCurrentStep((s) => Math.max(0, s - 1));

  return (
    <div className="min-h-screen w-full bg-gradient-to-b from-[#0b1220] to-[#05070c] text-slate-100">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              <span className="text-[#5fb1ff]">Involve Space</span> — SaaS / Tasking Planner
            </h1>
            <div className="flex items-center gap-2">
              <Button className="bg-white/10 border border-white/20" onClick={() => setCurrentStep(7)}>
                Open History
              </Button>
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

        {/* Layout: left steps, right live quote */}
        <div className="grid lg:grid-cols-3 gap-6">
          {/* LEFT COLUMN — steps */}
          <div className="lg:col-span-2 space-y-6">
            {/* STEP 0 — Service */}
            {currentStep === 0 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Select Service</h2>
                <div className="grid md:grid-cols-2 gap-3">
                  <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name="mode" checked={p.mode === "saas"} onChange={() => set("mode","saas")} />
                      SaaS (annual) <InfoTip id="mode" />
                    </label>
                    <p className="text-xs text-slate-400 mt-2">Annual price and capacity with chosen revisit.</p>
                  </div>
                  <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name="mode" checked={p.mode === "tasking"} onChange={() => set("mode","tasking")} />
                      Tasking (per mission/launch) <InfoTip id="mode" />
                    </label>
                    <p className="text-xs text-slate-400 mt-2">Define number of missions and profile. Compute per-mission and total.</p>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-slate-300">Client</label>
                    <input className="w-full border border-white/10 bg-white/5 text-slate-100 rounded-lg px-2 py-2"
                      value={p.client_name} onChange={(e)=>set("client_name",e.target.value)} placeholder="Client name" />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-300">AOI name</label>
                    <input className="w-full border border-white/10 bg-white/5 text-slate-100 rounded-lg px-2 py-2"
                      value={p.aoi_name} onChange={(e)=>set("aoi_name",e.target.value)} placeholder="e.g., Milan province" />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-400">Choose the service, then continue.</span>
                  <div className="flex gap-2">
                    <Button className="px-4 py-1.5" onClick={next}>Next →</Button>
                  </div>
                </div>
              </section>
            )}

            {/* STEP 1 — Platform type */}
            {currentStep === 1 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Platform Type</h2>
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

                {/* Platform presets */}
                <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                  <div className="text-sm font-medium mb-2 text-slate-200">Platform presets</div>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <select className="md:col-span-6 border border-white/10 rounded px-2 py-2 bg-white/5"
                            value={platSel} onChange={(e)=>setPlatSel(e.target.value)}>
                      <option value="">— select preset —</option>
                      {platPresets.map(pr => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                    </select>
                    <Button variant="secondary" className="md:col-span-2 py-2 bg-white/10 hover:bg-white/20" onClick={loadPlatPreset}>Load</Button>
                    <input className="md:col-span-3 border border-white/10 rounded px-2 py-2 bg-white/5"
                           placeholder="Preset name (e.g., Stratostats v2)" value={platName} onChange={(e)=>setPlatName(e.target.value)} />
                    <Button className="md:col-span-2 py-2" onClick={savePlatPreset}>Save</Button>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 items-center">
                    <Button variant="outline" className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={removePlat}>Delete selected</Button>
                    <span className="text-slate-400">Presets are stored locally in your browser.</span>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <Button variant="secondary" className="bg-white/10 border border-white/20" onClick={prev}>← Back</Button>
                  <Button onClick={next}>Next →</Button>
                </div>
              </section>
            )}

            {/* STEP 2 — Platform parameters */}
            {currentStep === 2 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Platform Parameters</h2>

                {p.platform === "relay" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div><label className="block text-sm text-slate-300">Flight duration (h) <InfoTip id="mission_days" /></label><Num v={p.relay_hours_h} on={(v)=>set("relay_hours_h",v)} /></div>
                    <div><label className="block text-sm text-slate-300">Turnaround (days)</label>
                      <input disabled className="w-full border border-white/10 bg-white/5 text-slate-400 rounded-lg px-2 py-2" value="—" />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      <div><label className="block text-sm text-slate-300">Mission duration (days) <InfoTip id="mission_days" /></label><Num v={p.mission_days} on={(v)=>set("mission_days",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Turnaround (days) <InfoTip id="turnaround_days" /></label><Num v={p.turnaround_days} on={(v)=>set("turnaround_days",v)} /></div>
                      <div><label className="block text-sm text-slate-300">MTBF h <InfoTip id="mtbf_h" /></label><Num v={p.mtbf_h} on={(v)=>set("mtbf_h",v)} /></div>
                      <div><label className="block text-sm text-slate-300">MTTR h <InfoTip id="mttr_h" /></label><Num v={p.mttr_h} on={(v)=>set("mttr_h",v)} /></div>
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-2">
                      <div><label className="block text-sm text-slate-300">Max flight days <InfoTip id="max_flight_days" /></label><Num v={p.max_flight_days} on={(v)=>set("max_flight_days",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Maintenance buffer <InfoTip id="maint_buffer" /></label><Num v={p.maint_buffer} on={(v)=>set("maint_buffer",v)} /></div>
                      <div><label className="block text-sm text-slate-300">Spare buffer <InfoTip id="spare_buffer" /></label><Num v={p.spare_buffer} on={(v)=>set("spare_buffer",v)} /></div>
                    </div>
                  </>
                )}

                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div><label className="block text-sm text-slate-300">Platform CAPEX <InfoTip id="capex_platform_EUR" /></label><Num v={p.capex_platform_EUR} on={(v)=>set("capex_platform_EUR",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Platform life (days) <InfoTip id="life_platform_days" /></label><Num v={p.life_platform_days} on={(v)=>set("life_platform_days",v)} /></div>
                </div>

                <div className="grid grid-cols-3 gap-3 mt-2">
                  <div><label className="block text-sm text-slate-300">Fixed cost per {p.platform==='relay'?'launch':'mission'} <InfoTip id="Cf_mission" /></label><Num v={p.Cf_mission} on={(v)=>set("Cf_mission",v)} /></div>
                  <div><label className="block text-sm text-slate-300">€/h (Ch) <InfoTip id="Ch_hour" /></label><Num v={p.Ch_hour} on={(v)=>set("Ch_hour",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Annual cloud costs <InfoTip id="annual_cloud_costs" /></label><Num v={p.annual_cloud_costs} on={(v)=>set("annual_cloud_costs",v)} /></div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <Button variant="secondary" className="bg-white/10 border border-white/20" onClick={prev}>← Back</Button>
                  <div className="flex gap-2">
                    <Button className="px-4 py-1.5" onClick={next}>Next →</Button>
                  </div>
                </div>
              </section>
            )}

            {/* STEP 3 — Payload & Navigation */}
            {currentStep === 3 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Payload & Navigation</h2>

                {/* Payload presets */}
                <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                  <div className="text-sm font-medium mb-2 text-slate-200">Payload presets</div>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <select className="md:col-span-6 border border-white/10 rounded px-2 py-2 bg-white/5"
                            value={paySel} onChange={(e)=>setPaySel(e.target.value)}>
                      <option value="">— select preset —</option>
                      {payPresets.map(pr => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                    </select>
                    <Button variant="secondary" className="md:col-span-2 py-2 bg-white/10 hover:bg-white/20" onClick={loadPayPreset}>Load</Button>
                    <input className="md:col-span-3 border border-white/10 rounded px-2 py-2 bg-white/5"
                           placeholder="Preset name (e.g., SAR v1 ECHOES)" value={payName} onChange={(e)=>setPayName(e.target.value)} />
                    <Button className="md:col-span-2 py-2" onClick={savePayPreset}>Save</Button>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 items-center">
                    <Button variant="outline" className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={removePay}>Delete selected</Button>
                    <span className="text-slate-400">Presets are stored locally in your browser.</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div><label className="block text-sm text-slate-300">Swath km <InfoTip id="swath_km" /></label><Num v={p.swath_km} on={(v)=>set("swath_km",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Ground speed km/h <InfoTip id="ground_speed_kmh" /></label><Num v={p.ground_speed_kmh} on={(v)=>set("ground_speed_kmh",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Duty <InfoTip id="duty" /></label><Num v={p.duty} on={(v)=>set("duty",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Coverage efficiency <InfoTip id="cov_eff" /></label><Num v={p.cov_eff} on={(v)=>set("cov_eff",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Overlap ρ <InfoTip id="overlap" /></label><Num v={p.overlap} on={(v)=>set("overlap",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Turn radius km <InfoTip id="turn_radius_km" /></label><Num v={p.turn_radius_km} on={(v)=>set("turn_radius_km",v)} /></div>
                  <div><label className="block text-sm text-slate-300">η nav <InfoTip id="eta_nav" /></label><Num v={p.eta_nav} on={(v)=>set("eta_nav",v)} /></div>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div><label className="block text-sm text-slate-300">Payload CAPEX <InfoTip id="capex_payload_EUR" /></label><Num v={p.capex_payload_EUR} on={(v)=>set("capex_payload_EUR",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Payload life (days) <InfoTip id="life_payload_days" /></label><Num v={p.life_payload_days} on={(v)=>set("life_payload_days",v)} /></div>
                  <div><label className="block text-sm text-slate-300">Consumables <InfoTip id="consumables_per_mission" /></label><Num v={p.consumables_per_mission} on={(v)=>set("consumables_per_mission",v)} /></div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <Button variant="secondary" className="bg-white/10 border border-white/20" onClick={prev}>← Back</Button>
                  <Button onClick={next}>Next →</Button>
                </div>
              </section>
            )}

            {/* STEP 4 — Mission parameters */}
            {currentStep === 4 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Mission Parameters</h2>

                {p.mode === "saas" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-sm mt-2 text-slate-300">Revisit minutes <InfoTip id="revisit_min" /></label>
                      <Num v={p.revisit_min} on={(v) => set("revisit_min", v)} />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-sm text-slate-300">Proposed annual price</label>
                      <Num v={p.proposed_annual_price_EUR} on={(v)=>set("proposed_annual_price_EUR",v)} />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-sm text-slate-300">Target GM % <InfoTip id="target_gm" /></label>
                      <Num v={p.target_gm} on={(v)=>set("target_gm",v)} />
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-1">
                      <label className="block text-sm text-slate-300"># {p.platform==='relay'?'launches':'missions'}</label>
                      <Num v={missionsCount} on={(v)=>set("missions_count",v)} />
                    </div>
                    <div className="col-span-1">
                      <label className="block text-sm text-slate-300">Mission profile</label>
                      <select className="w-full border border-white/10 rounded px-2 py-2 bg-white/5" value={p.mission_profile} onChange={(e)=>set("mission_profile",e.target.value)}>
                        {Object.entries(PROFILES).map(([k,x])=> <option key={k} value={k}>{x.name}</option>)}
                      </select>
                    </div>
                    <div className="col-span-1">
                      <label className="block text-sm text-slate-300">Proposed price / {p.platform==='relay'?'launch':'mission'}</label>
                      <Num v={p.proposed_price_per_mission_EUR} on={(v)=>set("proposed_price_per_mission_EUR",v)} />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-sm text-slate-300">Target GM % <InfoTip id="target_gm" /></label>
                      <Num v={p.target_gm} on={(v)=>set("target_gm",v)} />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-2">
                  <Button variant="secondary" className="bg-white/10 border border-white/20" onClick={prev}>← Back</Button>
                  <Button onClick={next}>Next →</Button>
                </div>
              </section>
            )}

            {/* STEP 5 — AOI */}
            {currentStep === 5 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">AOI Selection</h2>

                {/* AOI presets */}
                <div className="rounded-lg border border-white/10 p-3 bg-white/5">
                  <div className="text-sm font-medium mb-2 text-slate-200">AOI presets</div>
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                    <select className="md:col-span-6 border border-white/10 rounded px-2 py-2 bg-white/5"
                            value={selectedPresetId} onChange={(e)=>setSelectedPresetId(e.target.value)}>
                      <option value="">— select preset —</option>
                      {presets.map((pr) => (<option key={pr.id} value={pr.id}>{pr.name}</option>))}
                    </select>
                    <Button variant="secondary" className="md:col-span-2 py-2 bg-white/10 hover:bg-white/20 whitespace-nowrap" onClick={loadPreset}>Load</Button>
                    <input className="md:col-span-3 border border-white/10 rounded px-2 py-2 bg-white/5"
                           placeholder="New preset name" value={presetName} onChange={(e)=>setPresetName(e.target.value)} />
                    <Button className="md:col-span-2 py-2 whitespace-nowrap" title="Save current AOI as preset" onClick={saveCurrentAsPreset}>Save</Button>
                  </div>
                  <div className="mt-2 text-xs flex gap-2 items-center">
                    <Button variant="outline" className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={deleteSelectedPreset}>Delete selected</Button>
                    <span className="text-slate-400">Presets are stored locally in your browser.</span>
                  </div>
                </div>

                <div className="flex gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={p.aoiType === "areal"} onChange={() => set("aoiType", "areal")} /> Areal
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="radio" checked={p.aoiType === "corridor"} onChange={() => set("aoiType", "corridor")} /> Corridor
                  </label>
                </div>

                <label className="block text-sm text-slate-300">Area km² <InfoTip id="aoi_km2" /></label>
                <Num v={p.aoi_km2} on={(v) => set("aoi_km2", v)} />
                {p.aoiType === "areal" ? (
                  <>
                    <label className="block text-sm mt-2 text-slate-300">Width km <span className="opacity-60">(empty = √A)</span> <InfoTip id="aoi_width_km" /></label>
                    <Num v={p.aoi_width_km} on={(v) => set("aoi_width_km", v)} />
                  </>
                ) : (
                  <>
                    <label className="block text-sm mt-2 text-slate-300">Corridor width km <InfoTip id="corridor_width_km" /></label>
                    <Num v={p.corridor_width_km} on={(v) => set("corridor_width_km", v)} />
                  </>
                )}

                <div className="flex items-center justify-between pt-2">
                  <Button variant="secondary" className="bg-white/10 border border-white/20" onClick={prev}>← Back</Button>
                  <div className="flex gap-2">
                    <Button className="px-4 py-1.5" onClick={() => { setCurrentStep(6); setTimeout(()=>{resultsRef.current?.scrollIntoView({behavior:"smooth"}); setFlashResults(true); setTimeout(()=>setFlashResults(false), 1200);}, 50); }}>Go to Summary →</Button>
                  </div>
                </div>
              </section>
            )}

            {/* STEP 6 — Summary & confirm */}
            {currentStep === 6 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-lg p-4 space-y-5">
                <h2 className="text-[#9ed1ff] font-medium mb-1">Summary Sheet</h2>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="text-slate-400">Client</div><div className="text-right">{p.client_name || "—"}</div>
                  <div className="text-slate-400">AOI</div><div className="text-right">{p.aoi_name || "—"}</div>
                  <div className="text-slate-400">Mode</div><div className="text-right">{p.mode.toUpperCase()}</div>
                  <div className="text-slate-400">Platform</div><div className="text-right">{p.platform==='relay'?'Stratorelay':'Stratostats'}</div>

                  {p.mode==='tasking' && (
                    <>
                      <div className="text-slate-400">Profile</div><div className="text-right">{PROFILES[p.mission_profile].name}</div>
                      <div className="text-slate-400"># {p.platform==='relay'?'launches':'missions'}</div><div className="text-right">{missionsCount}</div>
                    </>
                  )}

                  {p.mode==='saas' && (
                    <>
                      <div className="text-slate-400">Revisit (min)</div><div className="text-right">{N(p.revisit_min,0)}</div>
                      <div className="text-slate-400">Revisits/year</div><div className="text-right">{m.revisitsY}</div>
                    </>
                  )}

                  <div className="col-span-2 border-t border-white/10 my-1"></div>

                  {p.mode==='saas' && (
                    <>
                      <div className="text-slate-400">Cost per km² per revisit</div><div className="text-right">{EUR(m.EURkm2_per_revisit, 2)}</div>
                      <div className="text-slate-400">Cost per km² per year</div><div className="text-right">{EUR(m.EURkm2_year, 2)}</div>
                    </>
                  )}
                  {p.mode!=='saas' && (
                    <>
                      <div className="text-slate-400">Cost per km² (per mission)</div><div className="text-right">{EUR(t.costPerKm2, 2)}</div>
                      <div className="text-slate-400">Price per km² (per mission)</div><div className="text-right">{EUR(t.pricePerKm2, 2)}</div>
                    </>
                  )}

                  <div className="text-slate-400">Cost per {p.platform==='relay' && p.mode==='tasking' ? 'launch' : 'mission'}</div><div className="text-right">{EUR(metrics.cost_per_mission)}</div>
                  <div className="text-slate-400">{p.mode==='saas' ? 'Annual cost (AOI)' : 'Total cost'}</div><div className="text-right">{EUR(metrics.cost_annual)}</div>

                  {p.mode==='saas' && (
                    <>
                      <div className="text-slate-400">Price per km² per revisit</div><div className="text-right">{EUR(m.PricePerKm2_per_revisit, 2)}</div>
                      <div className="text-slate-400">Price per km² per year</div><div className="text-right">{EUR(m.PricePerKm2_year, 2)}</div>
                    </>
                  )}

                  <div className="text-slate-400">Price per {p.platform==='relay' && p.mode==='tasking' ? 'launch' : 'mission'}</div><div className="text-right">{EUR(metrics.price_per_mission)}</div>

                  {metrics.GM_prop!=null && (
                    <>
                      <div className="text-slate-400">GM</div><div className="text-right">{N(metrics.GM_prop*100,1)}%</div>
                    </>
                  )}
                </div>

                {/* FINAL PRICE highlight */}
                <div className="rounded-2xl p-4 border relative overflow-hidden"
                     style={{borderColor:"rgba(99, 255, 181, 0.5)"}}
                >
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/15 via-sky-500/10 to-indigo-500/15 blur-3xl" />
                  <div className="relative">
                    <div className="text-xs uppercase tracking-wider text-emerald-300/90">Final price</div>
                    <div className="mt-1 text-3xl md:text-4xl font-semibold text-emerald-200 drop-shadow">
                      {p.mode==='saas' ? EUR(metrics.price_annual) : EUR(metrics.price_annual)}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      {p.mode==='saas' ? "Annual price for AOI" : "Total for the selected batch"}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <Button variant="secondary" className="bg-white/10 border border-white/20" onClick={prev}>← Back</Button>
                  <div className="flex gap-2">
                    <Button className="bg-white/10 border border-white/20" onClick={()=>setCurrentStep(7)}>Go to History</Button>
                    <Button
                      className="bg-emerald-500/20 border border-emerald-400 text-emerald-200"
                      onClick={saveQuote}
                    >
                      Confirm & Save to History
                    </Button>
                  </div>
                </div>
              </section>
            )}

            {/* STEP 7 — History */}
            {currentStep === 7 && (
              <section className="bg-white/5 border border-white/10 rounded-2xl shadow-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-[#9ed1ff] font-medium">Quotes History & Analytics</h2>
                  <div className="flex gap-2">
                    <Button className="bg-white/10 border border-white/20" onClick={() => {
                      const csv = toCSV(history);
                      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a"); a.href = url; a.download = "involve_space_quotes.csv"; a.click(); URL.revokeObjectURL(url);
                    }}>Export CSV</Button>
                    <Button className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={clearAllQuotes}>Clear all</Button>
                  </div>
                </div>

                <div className="grid sm:grid-cols-4 gap-3">
                  <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70"># Quotes</div><div className="text-xl font-semibold">{stats.count}</div></div>
                  <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70">Avg price</div><div className="text-xl font-semibold">{EUR(stats.avgPrice || 0)}</div></div>
                  <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70">Avg cost</div><div className="text-xl font-semibold">{EUR(stats.avgCost || 0)}</div></div>
                  <div className="rounded-xl bg-white/5 border border-white/10 p-3"><div className="text-xs opacity-70">Avg GM</div><div className="text-xl font-semibold">{N((stats.avgGM || 0) * 100, 1)}%</div></div>
                </div>

                <div className="overflow-auto rounded-xl border border-white/10">
                  <table className="min-w-[1400px] w-full text-sm">
                    <thead className="bg-white/5">
                      <tr className="text-left">
                        <th className="px-3 py-2">Date</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">AOI</th>
                        <th className="px-3 py-2">Mode</th><th className="px-3 py-2">Platform</th><th className="px-3 py-2">Profile</th>
                        <th className="px-3 py-2">Area km²</th><th className="px-3 py-2">Revisit (min)</th><th className="px-3 py-2"># Missions</th>
                        <th className="px-3 py-2">Cost/km² per revisit</th><th className="px-3 py-2">Cost/km² per year</th>
                        <th className="px-3 py-2">Cost/mission</th><th className="px-3 py-2">Annual cost</th>
                        <th className="px-3 py-2">Price/km² per revisit</th><th className="px-3 py-2">Price/km² per year</th>
                        <th className="px-3 py-2">Price/mission</th><th className="px-3 py-2">Final price</th>
                        <th className="px-3 py-2">GM</th><th className="px-3 py-2">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.length === 0 ? (
                        <tr><td colSpan={19} className="px-3 py-4 text-center text-slate-400">No saved quotes.</td></tr>
                      ) : history.map(q=>(
                        <tr key={q.id} className="border-t border-white/10">
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDate(q.ts)}</td>
                          <td className="px-3 py-2">{q.client_name}</td>
                          <td className="px-3 py-2">{q.aoi_name}</td>
                          <td className="px-3 py-2">{q.mode}</td>
                          <td className="px-3 py-2">{q.platform}</td>
                          <td className="px-3 py-2">{q.mission_profile}</td>
                          <td className="px-3 py-2">{N(q.aoi_km2,1)}</td>
                          <td className="px-3 py-2">{q.revisit_min ? N(q.revisit_min,0) : "—"}</td>
                          <td className="px-3 py-2">{q.missions_count || (q.mode==='saas'?'—':0)}</td>
                          <td className="px-3 py-2">{q.cost_km2_per_revisit!=null ? EUR(q.cost_km2_per_revisit,2) : "—"}</td>
                          <td className="px-3 py-2">{EUR(q.cost_km2_year, 2)}</td>
                          <td className="px-3 py-2">{EUR(q.cost_per_mission)}</td>
                          <td className="px-3 py-2">{EUR(q.cost_annual)}</td>
                          <td className="px-3 py-2">{q.price_km2_per_revisit!=null ? EUR(q.price_km2_per_revisit,2) : "—"}</td>
                          <td className="px-3 py-2">{EUR(q.price_km2_year, 2)}</td>
                          <td className="px-3 py-2">{EUR(q.price_per_mission)}</td>
                          <td className="px-3 py-2 font-semibold">{EUR(q.price_annual)}</td>
                          <td className="px-3 py-2">{q.GM_prop!=null ? `${N(q.GM_prop*100,1)}%` : "—"}</td>
                          <td className="px-3 py-2">
                            <div className="flex gap-2">
                              <Button className="bg-white/10 border border-white/20 text-slate-200" onClick={()=>loadQuoteIntoForm(q)}>Load</Button>
                              <Button className="border-red-400/40 text-red-300 hover:bg-red-500/10" onClick={()=>removeQuote(q.id)}>Delete</Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>

          {/* RIGHT COLUMN — Live Quote (always visible) */}
          <section ref={resultsRef} className={`bg-white/5 border border-white/10 rounded-2xl shadow-xl p-4 space-y-4 transition ${flashResults ? "ring-4 ring-emerald-400/60" : "ring-0"}`}>
            <CardHeader className="px-0 pt-0">
              <CardTitle className={p.mode === "saas" ? "text-[#9ed1ff]" : "text-emerald-300"}>
                Live Quote — {p.mode === "saas" ? `SaaS · ${p.platform === "relay" ? "Stratorelay" : "Stratostats"}` : `Tasking · ${p.platform === "relay" ? "Launch" : "Mission"}`}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0 space-y-2">
              <div className="text-xs text-slate-400">
                {p.client_name} • {p.aoi_name} • {p.platform==='relay'?'Stratorelay':'Stratostats'}
                {p.mode==='saas' ? ` • R=${N(p.revisit_min,0)} min` : ` • #=${missionsCount} • ${PROFILES[p.mission_profile].name}`}
              </div>

              <div className="border-t border-white/10 my-2" />

              {/* Costs */}
              {p.mode==='saas' ? (
                <>
                  <Row l="Cost per km² per revisit">{EUR(m.EURkm2_per_revisit, 2)}</Row>
                  <Row l="Cost per km² per year">{EUR(m.EURkm2_year, 2)}</Row>
                </>
              ) : (
                <>
                  <Row l="Cost per km² (per mission)">{EUR(t.costPerKm2, 2)}</Row>
                </>
              )}
              <Row l={`Cost per ${p.mode==='tasking'?(p.platform==='relay'?'launch':'mission'):'mission'}`}>{EUR(p.mode==='saas'?m.Cmis:t.Cmis)}</Row>
              <Row l={p.mode==='saas'?"Annual cost (AOI)":"Total cost"}>{EUR(p.mode==='saas'?m.Ann:t.tot)}</Row>

              <div className="border-t border-white/10 my-2" />

              {/* Prices */}
              {p.mode==='saas' ? (
                <>
                  <Row l="Price per km² per revisit">{EUR(m.PricePerKm2_per_revisit, 2)}</Row>
                  <Row l="Price per km² per year">{EUR(m.PricePerKm2_year, 2)}</Row>
                </>
              ) : (
                <>
                  <Row l="Price per km² (per mission)">{EUR(t.pricePerKm2, 2)}</Row>
                </>
              )}
              <Row l={`Price per ${p.mode==='tasking'?(p.platform==='relay'?'launch':'mission'):'mission (target GM)'}`}>{EUR(p.mode==='saas'?m.PricePerMission_target:t.Pm_final)}</Row>

              {/* FINAL PRICE highlight (always) */}
              <div className="mt-3 rounded-2xl p-4 border relative overflow-hidden"
                   style={{borderColor:"rgba(99, 255, 181, 0.5)"}}
              >
                <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/20 via-sky-500/10 to-indigo-500/20 blur-3xl" />
                <div className="relative">
                  <div className="text-xs uppercase tracking-wider text-emerald-300/90">Final price</div>
                  <div className="mt-1 text-2xl md:text-3xl font-semibold text-emerald-200 drop-shadow">
                    {p.mode==='saas' ? EUR(m.PriceAnnualChosen) : EUR(t.Ptot_final)}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    {p.mode==='saas' ? "Annual price for AOI" : "Total for the selected batch"}
                  </div>
                </div>
              </div>

              { (p.mode==='saas' && m.GM!=null) && <Row l="GM on proposed annual">{N(m.GM*100,1)}%</Row> }
              { (p.mode!=='saas' && t.hasUserPrice) && <Row l={`GM on proposed / ${p.platform==='relay'?'launch':'mission'}`}>{N(((t.userPm - t.Cmis)/t.userPm)*100,1)}%</Row> }

              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="bg-sky-500/20 border border-sky-400 text-sky-200" onClick={()=>setCurrentStep(6)}>
                  Open Summary
                </Button>
                <Button className="bg-white/10 border border-white/20 text-slate-200" onClick={goToHistory}>
                  Go to History
                </Button>
              </div>
            </CardContent>
          </section>
        </div>
      </div>
    </div>
  );
}
