import { gtfs } from "./sources/gtfs-static.js";

// Short station names for UI and corridor ("line") names.
const SHORT = {
  "60000": "Madrid Atocha", "17000": "Madrid Chamartín", "18000": "Madrid Atocha", "10000": "Madrid Príncipe Pío",
  "71801": "Barcelona Sants", "79400": "Barcelona França", "03216": "València J. Sorolla", "65000": "València Nord",
  "51003": "Sevilla", "60911": "Alicante", "04040": "Zaragoza", "08223": "Vigo", "31412": "A Coruña", "15100": "León",
  "15211": "Oviedo", "11511": "San Sebastián", "04307": "Figueres", "87089": "Marsella", "87303": "Lyon",
  "03309": "Villena AV", "08240": "Medina AV", "60600": "Albacete", "03208": "Cuenca", "04007": "Guadalajara",
  "08004": "Segovia", "04104": "Camp de Tarragona", "50500": "Córdoba", "54413": "Málaga",
};

export function shortName(code) {
  if (SHORT[code]) return SHORT[code];
  const s = gtfs.stations.get(code);
  if (!s) return "estación " + code;
  return s.name.split("/")[0].replace(/\s*-\s*/g, " ").replace(/^(.{26}).+$/, "$1…").trim();
}

// City for corridor names: "Madrid-Puerta de Atocha-Almudena Grandes" → "Madrid".
export function cityName(code) {
  const s = SHORT[code] || gtfs.stations.get(code)?.name || code;
  const first = s.split(/[-/]/)[0].trim();
  return first.replace(/\s+(Delicias|Sants|Nord|Santa Justa|AV|Chamartín|Atocha|Príncipe Pío|Campo Grande|Joaquín Sorolla|J\. Sorolla)$/i, "").trim() || first;
}

export function lineKey(origin, dest) {
  const a = cityName(origin), b = cityName(dest);
  return a.localeCompare(b, "es") <= 0 ? `${a} ↔ ${b}` : `${b} ↔ ${a}`;
}
