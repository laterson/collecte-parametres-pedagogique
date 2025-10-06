// server/utils/splitClassLabel.js (CommonJS)
function _clean(s){ return String(s||'').replace(/\s+/g,' ').trim(); }

function splitClassLabel(label){
  const raw = _clean(label);
  const m = raw.match(/\s*(?:\(|#|-|\/)\s*(\d+)\s*\)?\s*$/);
  if(!m) return { base: raw, division: 1, label: raw };
  const division = Number(m[1]||'1') || 1;
  const base = _clean(raw.slice(0, m.index));
  return { base, division, label: `${base} (${division})` };
}

function makeClassLabel(base, division=1){
  base = _clean(base);
  return (division && division !== 1) ? `${base} (${division})` : base;
}

// utile ailleurs parfois
function normStrict(s){
  return String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/\s+/g,'')
    .trim()
    .toLowerCase();
}

module.exports = { splitClassLabel, makeClassLabel, _clean, normStrict };
