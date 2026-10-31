// In-memory live state shared by the collector and the API.
export const state = {
  fleetUpdated: null, // Renfe's fechaActualizacion
  trains: new Map(), // n → normalized live train
  nucleos: new Map(), // Cercanías network id → name ("10" → "Madrid")
  cercaniasLines: null, // GeoJSON of Cercanías lines
  track: new Map(), // n → { lat, lon, ts, kmh, heading, stoppedSince, delayAtStop, runKey, nearDest, lastSeen }
  cancelled: new Map(), // "train|date" → { train, date, tripId }
  rtDelays: new Map(),
  incidents: { adif: [], adifReadAt: null, derived: [], renfe: [] },
  proximity: [], // active anomalies
  proximityStreak: new Map(),
  sources: {
    renfe: { ok: false },
    cercanias: { ok: false },
    gtfsCercanias: { ok: false },
    gtfsRt: { ok: false },
    renfeAlerts: { ok: false },
    adif: { ok: false },
    gtfs: { ok: false },
  },
};

/** Cancelled today (or on a given service date) per GTFS-RT. */
export const isCancelled = (train, date) => state.cancelled.has(train + "|" + date);
export const cancelledOn = (date) => [...new Set([...state.cancelled.values()].filter((c) => c.date === date).map((c) => c.train))];

export function sourceOk(name, extra = {}) {
  state.sources[name] = { ...state.sources[name], ok: true, at: new Date().toISOString(), error: null, ...extra };
}
export function sourceFail(name, err) {
  const msg = String(err?.message || err).slice(0, 300);
  state.sources[name] = { ...state.sources[name], ok: false, error: msg, triedAt: new Date().toISOString() };
  console.warn(`[${name}] ${msg}`);
}
