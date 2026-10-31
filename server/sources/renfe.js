// Renfe feeds: live LD/MD fleet, official GTFS-RT (trip updates + alerts), visor notices.
import { URLS } from "../config.js";
import { getJson } from "./http.js";
import { normCode, normTrain } from "./gtfs-static.js";

/** flotaLD.json → raw fixes */
export async function fetchFleet(url = URLS.flotaLD) {
  const d = await getJson(url);
  return {
    updated: d.fechaActualizacion, // local Madrid time, no zone
    trains: (d.trenes || []).map((t) => ({
      n: normTrain(t.codComercial),
      p: Number(t.codProduct),
      lat: Number(t.latitud), lon: Number(t.longitud),
      ts: Number(t.time) * 1000,
      ret: Number.parseInt(t.ultRetraso, 10) || 0,
      ant: normCode(t.codEstAnt), sig: normCode(t.codEstSig),
      ori: normCode(t.codOrigen), des: normCode(t.codDestino),
      nextAt: t.horaLlegadaSigEst || null,
      acc: !!t.accesible,
      mat: t.mat || null,
    })),
  };
}

/** flota.json (Cercanías/Rodalies) → raw positions. No per-train timestamp: the fetch time is used. */
export async function fetchCercanias() {
  const d = await getJson(URLS.flotaCercanias);
  return {
    updated: d.fechaActualizacion,
    trains: (d.trenes || []).map((t) => ({
      n: normTrain(t.codTren), line: t.codLinea || "", nucleo: String(t.nucleo || ""), tripId: t.tripId,
      lat: Number(t.latitud), lon: Number(t.longitud),
      ret: Number.parseInt(t.retrasoMin, 10) || 0,
      act: normCode(t.codEstAct), sig: normCode(t.codEstSig), ori: normCode(t.codEstOrig), des: normCode(t.codEstDest),
      nextAt: t.horaLlegadaSigEst || null, via: t.via || null, nextVia: t.nextVia || null,
      acc: !!t.accesible,
    })),
  };
}

/** Cercanías line shapes: { nucleos: Map id → name, geo: FeatureCollection } */
export async function fetchCercaniasLines() {
  const geo = await getJson(URLS.lineasCercanias);
  const nucleos = new Map();
  for (const f of geo.features || []) nucleos.set(String(f.properties.IDNUCLEO), f.properties.NUCLEO);
  return { nucleos, geo };
}

/** Live departure board for a Cercanías station (Renfe only publishes these for Cercanías). */
export async function fetchSalidas(code) {
  const d = await getJson(URLS.salidas(code), { timeoutMs: 10_000 });
  const parse = (s) => { const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/.exec(s || ""); return m ? `${m[4]}:${m[5]}` : null; };
  return (d.estacion?.salidas || []).map((s) => ({
    train: normTrain(s.trenId), line: s.linea, dest: normCode(s.destino), destName: s.destinoNombre,
    planned: parse(s.horaSalidaPlanificada), real: parse(s.horaSalidaReal), platform: s.via || null, acc: s.accesible === 1 || s.accesible === 2,
  }));
}

/** GTFS-RT LD trip updates → { delays: Map train→sec, cancelled: [{train, date}], added: [...] } */
export async function fetchTripUpdatesLD() {
  const d = await getJson(URLS.gtfsRtTripUpdatesLD);
  const cancelled = [], added = [], delays = new Map();
  for (const e of d.entity || []) {
    const tu = e.tripUpdate; if (!tu) continue;
    const id = tu.trip?.tripId || "";
    const m = id.match(/^(\d{5})\d(\d{4}-\d{2}-\d{2})$/);
    const train = normTrain(m ? m[1] : id.slice(0, 5));
    const date = m ? m[2] : null;
    const rel = tu.trip?.scheduleRelationship;
    if (rel === "CANCELED") cancelled.push({ train, date, tripId: id });
    else {
      if (rel === "ADDED") added.push({ train, date, tripId: id });
      if (tu.delay != null) delays.set(train, Number(tu.delay));
    }
  }
  return { ts: Number(d.header?.timestamp) * 1000, delays, cancelled, added };
}

/** GTFS-RT alerts (mostly Cercanías service changes) */
export async function fetchGtfsRtAlerts() {
  const d = await getJson(URLS.gtfsRtAlerts);
  return (d.entity || []).map((e) => {
    const a = e.alert || {};
    const text = a.descriptionText?.translation?.find((t) => t.language === "es")?.text || a.descriptionText?.translation?.[0]?.text || "";
    return {
      id: "rt-" + e.id,
      start: a.activePeriod?.[0]?.start ? Number(a.activePeriod[0].start) * 1000 : null,
      routes: (a.informedEntity || []).map((x) => x.routeId).filter(Boolean),
      stops: (a.informedEntity || []).map((x) => x.stopId).filter(Boolean),
      text,
    };
  });
}

/** Visor notices: { estacion: [...], linea: [...] } */
export async function fetchRenfeAlerts() {
  const d = await getJson(URLS.renfeAlerts);
  const es = (x) => x.idiomas?.find((i) => i.lengua === "es")?.texto || x.idiomas?.[0]?.texto || "";
  const av = d.avisos || {};
  return [
    ...(av.estacion || []).map((x, i) => ({ id: `renfe-e-${x.estacion}-${i}`, kind: "estacion", nucleo: x.idnegocio, station: normCode(x.estacion), text: es(x) })),
    ...(av.linea || []).map((x, i) => ({ id: `renfe-l-${x.idnegocio}-${x.linea}-${i}`, kind: "linea", nucleo: x.idnegocio, line: x.linea, text: es(x) })),
  ];
}
