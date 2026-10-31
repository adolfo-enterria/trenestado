// Renfe product codes (codProduct in flotaLD.json) → train type used for filters.
export const TYPES = [
  { id: "ave", name: "AVE", prod: [2, 25] },
  { id: "avlo", name: "Avlo", prod: [28] },
  { id: "avant", name: "Avant", prod: [3] },
  { id: "alvia", name: "Alvia", prod: [11] },
  { id: "ld", name: "Euromed e Intercity", prod: [10, 13, 4, 5, 7, 8, 9, 24] },
  { id: "md", name: "Media distancia y regionales", prod: [14, 15, 16, 18, 19, 20, 21, 0] },
  { id: "cer", name: "Cercanías", network: "cer" },
  { id: "iryo", name: "Iryo", noData: true },
  { id: "ouigo", name: "Ouigo", noData: true },
];

export const PRODUCT_NAME = {
  2: "AVE", 25: "AVE", 28: "Avlo", 3: "Avant", 11: "Alvia", 10: "Euromed", 13: "Intercity", 4: "Talgo",
  5: "Altaria", 7: "Diurno", 8: "Estrella", 9: "Tren Hotel", 24: "AV City", 14: "Andalucía Exprés",
  15: "Catalunya Exprés", 16: "Media distancia", 18: "Regional", 19: "Regional Exprés", 20: "TRD", 21: "Proximidad",
};

// GTFS route_short_name → product code, for trains we only know from the timetable.
const GTFS_NAME = {
  AVE: 2, AVLO: 28, AVANT: 3, ALVIA: 11, EUROMED: 10, INTERCITY: 13, TALGO: 4, ALTARIA: 5,
  "MD": 16, "MEDIA DISTANCIA": 16, REGIONAL: 18, "REG.EXP.": 19, "REGIONAL EXPRES": 19, TRD: 20,
  PROXIMDAD: 21, PROXIMIDAD: 21, "AV CITY": 24, "TREN HOTEL": 9, "AVE INT": 25, "AVANT EXP": 3, TRENCELTA: 18,
};
export const productFromGtfsName = (s) => GTFS_NAME[String(s || "").trim().toUpperCase()] ?? null;

export const typeOf = (p) => TYPES.find((t) => t.prod && t.prod.includes(p)) || TYPES.find((t) => t.id === "md");
export const CER = TYPES.find((t) => t.id === "cer");
export const productName = (p, fallback = "Tren") => PRODUCT_NAME[p] || fallback;
