import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");

export const PORT = Number(process.env.PORT) || 3000;

export const URLS = {
  flotaLD: "https://tiempo-real.renfe.com/renfe-visor/flotaLD.json",
  flotaCercanias: "https://tiempo-real.renfe.com/renfe-visor/flota.json",
  lineasCercanias: "https://tiempo-real.renfe.com/renfe-visor/lineas.geojson",
  salidas: (code) => `https://tiempo-real.renfe.com/renfe-json-cutter/write/salidas/estacion/${code}.json`,
  flotaLDAnterior: "https://tiempo-real.renfe.com/renfe-visor/flotaLD_anterior.json",
  renfeAlerts: "https://tiempo-real.renfe.com/renfe-visor/alerts.json",
  cercaniasStations: "https://tiempo-real.renfe.com/data/estaciones.geojson",
  gtfsRtTripUpdatesLD: "https://gtfsrt.renfe.com/trip_updates_LD.json",
  gtfsRtAlerts: "https://gtfsrt.renfe.com/alerts.json",
  gtfsStatic: "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip",
  adif: "https://www.adif.es/viajeros/estado-de-la-red",
};

// Polling intervals (ms)
export const EVERY = {
  live: (Number(process.env.LIVE_SECONDS) || 60) * 1000, // 60 s matches the free-tier plan (docs/free-tier.md)
  gtfsRt: 60_000,
  renfeAlerts: 5 * 60_000,
  adif: 60_000, // one honest request a minute
  gtfsStatic: 24 * 3600_000,
  snapshot: 5 * 60_000,
  cleanup: 3600_000,
};

export const UA = "trenestado/0.1 (proyecto personal; datos abiertos de Renfe)";

export const DELAY = { leve: 5, grave: 15 };

export const PROXIMITY = {
  maxFixAgeS: 60,
  minKmh: 30,
  maxHeadingDiff: 30,
  stationExclusionKm: 1.5,
  decel: 0.5, // m/s², conservative service braking
  marginM: 500,
  persistCycles: 2,
};

export const STOPPED = {
  kmh: 4,
  minMinutes: 5, // "stopped unexpectedly" between stations
  majorMinutes: 15,
  majorDelayRise: 15,
};

// Statistics windows (days; YTD = since 1 January)
export const WINDOWS = { now: 0, "1D": 1, "7D": 7, "1M": 30, "3M": 91, "6M": 182, "1A": 365, YTD: null };

export const RETENTION = { snapshotsDays: 7, cercaniasRunsDays: 90 };
