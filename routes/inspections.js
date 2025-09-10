// routes/inspections.js
const express = require('express');
const router = express.Router();
const Inspection = require('../models/Inspection');
const DisciplineCatalog = require('../models/DisciplineCatalog');
const { isAuth, isAdmin } = require('../middleware/authsuupr');

/* Liste (authentifié) */
router.get('/', isAuth, async (_req,res)=>{
  const rows = await Inspection.find({}).sort({ nom:1 }).lean();
  res.json(rows);
});

/* Création (admin) */
router.post('/', isAuth, isAdmin, async (req,res)=>{
  const { key, nom, cycles={}, cyclesEnabled } = req.body || {};
  if(!key || !nom) return res.status(400).json({ error:'key & nom requis' });
  const ce = cyclesEnabled || cycles || {};
  try{
    const doc = await Inspection.create({
      key:String(key).toLowerCase().replace(/[^a-z0-9]+/g,''),
      nom:String(nom).trim(),
      cyclesEnabled:{ premier:!!ce.premier, second:!!ce.second }
    });
    res.json({ message:'OK', id:doc._id });
  }catch(e){
    if(e.code===11000) return res.status(409).json({ error:'clé déjà utilisée' });
    res.status(500).json({ error:'create failed' });
  }
});

/* Mise à jour (admin) */
router.put('/:id', isAuth, isAdmin, async (req,res)=>{
  const { nom, cycles={}, cyclesEnabled } = req.body || {};
  const ce = cyclesEnabled || cycles || {};
  const set = {};
  if(nom!=null) set.nom = String(nom).trim();
  set.cyclesEnabled = { premier:!!ce.premier, second:!!ce.second };
  await Inspection.findByIdAndUpdate(req.params.id, set);
  res.json({ message:'MAJ OK' });
});

/* Suppression (admin) – refus si disciplines liées */
router.delete('/:id', isAuth, isAdmin, async (req,res)=>{
  const insp = await Inspection.findById(req.params.id);
  if(!insp) return res.status(404).json({ error:'not found' });
  const count = await DisciplineCatalog.countDocuments({ inspection: insp.key });
  if(count>0) return res.status(409).json({ error:`impossible: ${count} discipline(s) liées` });
  await Inspection.deleteOne({ _id: req.params.id });
  res.json({ message:'supprimé' });
});

module.exports = router;

