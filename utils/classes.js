// Classe "canonique" = libellé sans le suffixe de division.
// Exemple: "1ère année DECO (3)" -> base="1ère année DECO", division=3
const CLEAN_SPACES = s => String(s || '').replace(/\s+/g, ' ').trim();

function splitClassLabel(label) {
  const raw = CLEAN_SPACES(label);
  // tolère "(2)", "#2", "- 2", "/2" en fin
  const m = raw.match(/\s*(?:\(|#|-|\/)\s*(\d+)\s*\)?\s*$/);
  if (!m) return { base: raw, division: 1, label: raw };
  const div = Number(m[1] || '1') || 1;
  const base = CLEAN_SPACES(raw.slice(0, m.index));
  return { base, division: div, label: `${base} (${div})` };
}

function makeClassLabel(base, division = 1) {
  const b = CLEAN_SPACES(base);
  return (division && division !== 1) ? `${b} (${division})` : b;
}

function canonical(label) {
  return splitClassLabel(label).base;
}

module.exports = { splitClassLabel, makeClassLabel, canonical };
