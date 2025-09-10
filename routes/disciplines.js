// routes/disciplines.js
const express = require('express');
const router = express.Router();
const DisciplineCatalog = require('../models/DisciplineCatalog');
const { isAuth, isAdmin } = require('../middleware/authsuupr');

const toSlug = (s='') =>
  String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'').replace(/_+/g,'_').toUpperCase();

async function uniqueCode({ inspection, specialite, nom, hint }){
  const base = (hint || `${specialite}_${toSlug(nom)}`).toUpperCase().slice(0, 48);
  let candidate = base || `${specialite}_${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  let i = 2;
  while (await DisciplineCatalog.exists({ inspection, code:candidate })) {
    candidate = `${base}_${i++}`.slice(0, 60);
  }
  return candidate;
}

/* Slug/aperçu code */
router.get('/slug', isAuth, async (req,res)=>{
  const user = req.session.user || {};
  const isAdminRole = user.role === 'admin';
  const { specialite, nom } = req.query;

  const inspection = isAdminRole
    ? String(req.query.inspection || user.inspection || '').toLowerCase()
    : String(user.inspection || '').toLowerCase();

  if(!inspection || !specialite || !nom) {
    return res.status(400).json({ error:'inspection, specialite, nom requis' });
  }

  res.json({
    code: await uniqueCode({
      inspection,
      specialite:String(specialite).toUpperCase(),
      nom
    })
  });
});

/* List (durci pour non-admin) */
router.get('/', isAuth, async (req,res)=>{
  const user = req.session.user || {};
  const isAdminRole = user.role === 'admin';

  const q = {};
  q.inspection = isAdminRole
    ? (req.query.inspection ? String(req.query.inspection).toLowerCase() : String(user.inspection||'').toLowerCase())
    : String(user.inspection||'').toLowerCase();

  if(req.query.cycle)      q.cycle      = String(req.query.cycle);
  if(req.query.specialite) q.specialite = String(req.query.specialite).toUpperCase();
  if(req.query.actif==='true')  q.actif = true;
  if(req.query.actif==='false') q.actif = false;

  const rows = await DisciplineCatalog.find(q).sort({ ordre:1, nom:1 }).lean();
  res.json(rows);
});

/* Create */
router.post('/', isAuth, isAdmin, async (req,res)=>{
  let { inspection, cycle, specialite, nom, code, actif=true, ordre=0, aliases=[] } = req.body || {};
  if(!inspection||!cycle||!specialite||!nom) return res.status(400).json({ error:'inspection, cycle, specialite, nom requis' });

  inspection = String(inspection).toLowerCase();
  specialite = String(specialite).toUpperCase();
  nom = String(nom).trim();
  code = (code || await uniqueCode({ inspection, specialite, nom })).toUpperCase();

  try{
    const doc = await DisciplineCatalog.create({ inspection, cycle, specialite, nom, code, actif:!!actif, ordre:Number(ordre)||0, aliases });
    res.json({ message:'OK', id:doc._id, code:doc.code });
  }catch(e){
    if(e.code===11000){
      const newCode = await uniqueCode({ inspection, specialite, nom, hint:code });
      const doc = await DisciplineCatalog.create({ inspection, cycle, specialite, nom, code:newCode, actif:!!actif, ordre:Number(ordre)||0, aliases });
      return res.json({ message:'OK', id:doc._id, code:doc.code });
    }
    res.status(500).json({ error:'create failed' });
  }
});

/* Import (upsert par {inspection,code}) */
router.post('/import', isAuth, isAdmin, async (req,res)=>{
  const rows = Array.isArray(req.body) ? req.body : [];
  if(!rows.length) return res.status(400).json({ error:'tableau vide' });

  let ok=0, ko=0;
  for (const r of rows){
    try{
      let { inspection, cycle, specialite, nom, code, actif=true, ordre=0, aliases=[] } = r;
      if(!inspection||!cycle||!specialite||!nom){ ko++; continue; }
      inspection = String(inspection).toLowerCase();
      specialite = String(specialite).toUpperCase();
      nom = String(nom).trim();
      code = (code || await uniqueCode({ inspection, specialite, nom })).toUpperCase();

      await DisciplineCatalog.updateOne(
        { inspection, code },
        { $set:{ cycle, specialite, nom, actif:!!actif, ordre:Number(ordre)||0, aliases } },
        { upsert:true }
      );
      ok++;
    }catch(_){ ko++; }
  }
  res.json({ message:'import terminé', ok, ko });
});

/* Update / enable / disable / delete */
router.put('/:id', isAuth, isAdmin, async (req,res)=>{
  const set = {};
  ['nom','cycle','specialite','actif','ordre','aliases'].forEach(k=>{
    if (req.body[k]!==undefined) set[k] = req.body[k];
  });
  if(set.specialite) set.specialite = String(set.specialite).toUpperCase();
  await DisciplineCatalog.findByIdAndUpdate(req.params.id, set);
  res.json({ message:'MAJ OK' });
});

router.patch('/:id/enable',  isAuth, isAdmin, async (req,res)=>{ await DisciplineCatalog.findByIdAndUpdate(req.params.id,{actif:true});  res.json({message:'activée'}); });
router.patch('/:id/disable', isAuth, isAdmin, async (req,res)=>{ await DisciplineCatalog.findByIdAndUpdate(req.params.id,{actif:false}); res.json({message:'désactivée'}); });
router.delete('/:id', isAuth, isAdmin, async (req,res)=>{ await DisciplineCatalog.deleteOne({ _id:req.params.id }); res.json({ message:'supprimée' }); });

module.exports = router;


