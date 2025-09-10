// routes/inspection_defaults.js
const express = require('express');
const router = express.Router();
const InspDefaults = require('../models/InspDefaults');
const { isAuth, isInsp } = require('../middleware/auth');

// GET /api/inspection/defaults?all=1
// GET /api/inspection/defaults?specialite=AF1
router.get('/defaults', isAuth, async (req,res)=>{
  const { all, specialite } = req.query;
  if (all) {
    const docs = await InspDefaults.find({}).lean();
    const classesBySpec = {}, defaultsBySpec = {};
    for (const d of docs) {
      if (Array.isArray(d.classes) && d.classes.length)     classesBySpec[d.specialite]  = d.classes;
      if (Array.isArray(d.disciplines) && d.disciplines.length) defaultsBySpec[d.specialite] = d.disciplines;
    }
    return res.json({ classesBySpec, defaultsBySpec });
  }
  if (!specialite) return res.status(400).json({ error:'specialite requise' });
  const d = await InspDefaults.findOne({ specialite }).lean();
  if (!d) return res.status(404).json({ error:'not found' });
  res.json({ classes:d.classes||[], disciplines:d.disciplines||[] });
});

// POST /api/inspection/defaults  (IPR uniquement)
router.post('/defaults', isAuth, isInsp, async (req,res)=>{
  const { specialite, classes = [], disciplines = [] } = req.body || {};
  if (!specialite) return res.status(400).json({ error:'specialite requise' });
  await InspDefaults.updateOne(
    { specialite },
    { $set:{ classes, disciplines }},
    { upsert:true }
  );
  res.json({ ok:true });
});

module.exports = router;
