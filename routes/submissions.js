// routes/submissions.js
const express = require('express');
const Collecte = require('../models/Collecte');
const { isAuth, isInsp } = require('../middleware/authsuupr');

const router = express.Router();

/**
 * GET /api/submissions/matrix?cycle=&specialite=
 * Renvoie, par (établissement, animateur), les évaluations déposées (1..6)
 * + l'id du dernier dépôt par évaluation.
 */
router.get('/matrix', isAuth, isInsp, async (req, res) => {
  try {
    const { cycle, specialite } = req.query;
    const q = { inspection: (req.session.user?.inspection || '').toLowerCase() };
    if (cycle) q.cycle = String(cycle);
    if (specialite) q.specialite = String(specialite);

    const list = await Collecte.find(q, { etablissement:1, animateur:1, evaluation:1, dateDepot:1 })
      .sort({ etablissement:1, animateur:1, evaluation:1, dateDepot:-1, _id:-1 })
      .lean();

    const map = new Map();
    for (const d of list) {
      const etab = d.etablissement || '';
      const anim = d.animateur || '';
      const key  = `${etab}||${anim}`;
      const ev   = String(Number(d.evaluation || 0)); // "1".."6"
      if (!['1','2','3','4','5','6'].includes(ev)) continue;

      if (!map.has(key)) {
        map.set(key, { etablissement: etab, animateur: anim, evaluations: {}, ids: {} });
      }
      const row = map.get(key);
      if (!row.ids[ev]) { row.evaluations[ev] = true; row.ids[ev] = String(d._id); }
    }

    const out = [...map.values()].map(r => {
      const evaluations = { ...r.evaluations };
      for (const k of ['1','2','3','4','5','6']) if (evaluations[k] !== true) evaluations[k] = false;
      return { ...r, evaluations };
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;


