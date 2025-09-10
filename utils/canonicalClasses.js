// utils/canonicalClasses.js
function upper(s){ return String(s||'').trim().toUpperCase(); }

/**
 * cycle: "premier" | "second"
 * sigle: ex "DECO", "AF1", "F3"
 * -> renvoie la liste des noms canoniques uniformes
 */
function buildCanonicalNames(cycle, sigle){
  const S = upper(sigle);
  if (cycle === 'premier') {
    return [
      `1ère Année ${S}`,
      `2ème Année ${S}`,
      `3ème Année ${S}`,
      `4ème Année ${S}`,
    ];
  }
  if (cycle === 'second') {
    return [
      `2nde ${S}`,
      `1ère ${S}`,
      `Tle ${S}`,
    ];
  }
  return [];
}

/** Optionnel: vérifie si une classe correspond au format attendu */
function isCanonicalClassName(name){
  const s = String(name||'');
  return /^(1ère Année|2ème Année|3ème Année|4ème Année|2nde|1ère|Tle)\s+[A-Z0-9]+$/.test(s);
}

module.exports = { buildCanonicalNames, isCanonicalClassName };
