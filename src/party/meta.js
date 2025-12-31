function buildMeta(meta) {
  const pairs = Object.entries(meta).map(([k, v]) => `${k}=${v}`);
  return `DDG|party|${pairs.join("|")}`;
}

function parseMeta(text) {
  if (!text?.startsWith("DDG|party|")) return null;
  const raw = text.split("|").slice(2);
  const meta = {};
  for (const p of raw) {
    const idx = p.indexOf("=");
    if (idx < 0) continue;
    meta[p.slice(0, idx)] = p.slice(idx + 1);
  }
  return meta;
}

module.exports = { buildMeta, parseMeta };
