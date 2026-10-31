import { UA } from "../config.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

/** Strict UTF-8, falling back to Latin-1 for feeds that aren't UTF-8. */
export function decodeText(buf) {
  try { return utf8.decode(buf); } catch { return latin1.decode(buf); }
}

export async function getText(url, { timeoutMs = 20_000 } = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
  const body = decodeText(new Uint8Array(await r.arrayBuffer()));
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

export const getJson = async (url, opts) => JSON.parse(await getText(url, opts));
