// server/utils/ap-scope.js
function scopedForAP(req, base = {}) {
  const f = { ...base };
  if (!req.user) return f;

  // si AP → force son établissement
  if (req.user.role === 'anim') {
    f.etablissement = req.user.etab || '';
  }

  // inspection déjà forcée par limitToInspection()
  if (req.user.inspection) {
    f.inspection = (req.user.inspection || '').toLowerCase();
  }
  return f;
}

module.exports = { scopedForAP };
