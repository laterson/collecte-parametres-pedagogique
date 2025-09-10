// server/routes/submissions.js
const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../middleware/auth');
const Collecte = require('../../models/Collecte');

router.use(requireAuth);

// /api/submissions/matrix?cycle=&specialite=
router.get('/matrix', async (req,res)=>{
  const match = {
    inspection: req.user.inspection
  };
  if(req.query.cycle)      match.cycle      = String(req.query.cycle).toLowerCase();
  if(req.query.specialite) match.specialite = String(req.query.specialite).toUpperCase();

  const docs = await Collecte.find(match).lean();
  const per = new Map(); // key -> {etablissement, animateur, evaluations:{}, ids:{}}

  for(const d of docs){
    const key = `${d.etablissement}||${d.animateur}`;
    const slot = per.get(key) || { etablissement:d.etablissement, animateur:d.animateur, evaluations:{}, ids:{} };
    slot.evaluations[String(d.evaluation)] = true;
    slot.ids[String(d.evaluation)] = String(d._id);
    per.set(key, slot);
  }

  res.json([...per.values()]);
});

module.exports = router;
