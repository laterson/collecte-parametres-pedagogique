// routes/ap.js
const express = require('express');
const router  = express.Router();

const Collecte = require('../models/Collecte');
const Teacher  = require('../models/Teacher');

const norm = s => String(s ?? '').trim();
const n = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim()!=='') return Number(v) || 0;
  }
  return 0;
};
const getDiscs = (c)=> Array.isArray(c?.disciplines) ? c.disciplines : (Array.isArray(c?.modules) ? c.modules : []);

/* ========= GUARD: AP connecté ========= */
function requireAnim(req, res, next){
  if (!req.user) return res.status(401).json({ error:'auth required' });
  if (!['anim','admin','insp'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  // On permet aussi admin/insp pour tests; on peut restreindre à 'anim' si besoin
  next();
}

/* =========================================================================
 *  A) EFFECTIFS PAR CLASSE (filles / garçons)
 * =========================================================================
 *
 * Architecture choisie : on stocke les effectifs au niveau "classe"
 * dans le document de collecte (schema Collecte) :
 *   doc.classes[i].filles, doc.classes[i].garcons
 *
 * Endpoints :
 *  - GET  /api/ap/effectifs?annee=&cycle=&specialite=&evaluation=
 *  - POST /api/ap/effectifs  (body = { annee, cycle, specialite, evaluation, items:[{classe, filles, garcons}] })
 */

// GET lecture des effectifs saisis (pour préremplir le panneau latéral AP)
router.get('/effectifs', requireAnim, async (req,res)=>{
  const u = req.user;
  const f = {
    inspection : String(u.inspection||'artsplastiques').toLowerCase(),
    etablissement: u.etab,
    annee      : String(req.query.annee||'').trim(),
    cycle      : String(req.query.cycle||'').trim(),
    specialite : String(req.query.specialite||'').toUpperCase(),
    evaluation : Number(req.query.evaluation||0)
  };
  if (!f.annee || !f.cycle || !f.specialite || !f.evaluation) {
    return res.status(400).json({ error:'annee, cycle, specialite, evaluation requis' });
  }

  const doc = await Collecte.findOne(f).lean();
  const rows = [];
  (doc?.classes||[]).forEach(c=>{
    rows.push({
      classe : c.nom || '',
      filles : Number(c.filles||0),
      garcons: Number(c.garcons||0),
      total  : Number(c.filles||0) + Number(c.garcons||0)
    });
  });
  res.json({ rows });
});

// POST upsert des effectifs saisis par classe
router.post('/effectifs', requireAnim, async (req,res)=>{
  const u = req.user;
  const { annee, cycle, specialite, evaluation, items=[] } = req.body||{};
  if (!annee || !cycle || !specialite || !evaluation) {
    return res.status(400).json({ error:'annee, cycle, specialite, evaluation requis' });
  }
  const F = {
    inspection : String(u.inspection||'artsplastiques').toLowerCase(),
    etablissement: u.etab,
    annee      : String(annee),
    cycle      : String(cycle),
    specialite : String(specialite).toUpperCase(),
    evaluation : Number(evaluation)
  };

  // upsert du document de collecte concerné
  const doc = await Collecte.findOne(F) || new Collecte({ ...F, animateur:u.nom || u.email, classes:[] });

  // MàJ classes[].filles/garcons
  const wantedMap = new Map();
  (Array.isArray(items) ? items : []).forEach(it=>{
    const key = norm(it.classe);
    if (!key) return;
    wantedMap.set(key, { filles:Number(it.filles||0), garcons:Number(it.garcons||0) });
  });

  // On parcourt les classes déjà présentes / on crée celles manquantes
  const byName = new Map();
  (doc.classes||[]).forEach(c => byName.set(norm(c.nom), c));

  for (const [name, vals] of wantedMap.entries()){
    let c = byName.get(name);
    if (!c){
      c = { nom:name, disciplines:[] };
      doc.classes.push(c);
      byName.set(name, c);
    }
    c.filles  = Number(vals.filles||0);
    c.garcons = Number(vals.garcons||0);
  }

  await doc.save();
  res.json({ ok:true, updated: wantedMap.size });
});


/* =========================================================================
 *  B) PERSONNEL ENSEIGNANT
 * =========================================================================
 *
 * Stockage dans une collection dédiée "Teacher".
 *
 * Endpoints :
 *  - GET  /api/ap/personnel?annee=&q=  (liste pour l’AP courant)
 *  - POST /api/ap/personnel            (ajout/maj d’un enseignant)
 *  - DELETE /api/ap/personnel/:id      (suppression)
 */

router.get('/personnel', requireAnim, async (req,res)=>{
  const u = req.user;
  const annee = String(req.query.annee||'').trim();
  if (!annee) return res.status(400).json({ error:'annee requis' });

  const q = (req.query.q||'').toString().toLowerCase();
  const rows = await Teacher.find({
    inspection   : String(u.inspection||'artsplastiques').toLowerCase(),
    etablissement: u.etab,
    annee
  }).sort({ nom:1 }).lean();

  const filtered = q
    ? rows.filter(r=>{
        const blob = [r.nom,r.grade,r.matiere,(r.classes||[]).join(','),(r.disciplines||[]).join(','),r.statut].join(' ').toLowerCase();
        return blob.includes(q);
      })
    : rows;

  res.json({ rows: filtered });
});

// upsert d’un enseignant (clé unique par inspection/etab/annee/nom)
router.post('/personnel', requireAnim, async (req,res)=>{
  const u = req.user;
  const {
    annee, nom, grade='', matiere='',
    statut='Enseignant', classes=[], disciplines=[], observations=''
  } = req.body||{};

  if (!annee || !nom) return res.status(400).json({ error:'annee & nom requis' });

  const key = {
    inspection   : String(u.inspection||'artsplastiques').toLowerCase(),
    etablissement: u.etab,
    annee        : String(annee),
    nom          : String(nom).trim()
  };

  const payload = {
    ...key,
    grade:String(grade||'').trim(),
    matiere:String(matiere||'').trim(),
    statut:String(statut||'').trim(),
    classes:Array.isArray(classes) ? classes.map(String) : [],
    disciplines:Array.isArray(disciplines) ? disciplines.map(String) : [],
    observations:String(observations||'').trim(),
    createdBy: u.email || u.nom || ''
  };

  const doc = await Teacher.findOneAndUpdate(key, { $set: payload }, { upsert:true, new:true, setDefaultsOnInsert:true });
  res.json({ ok:true, id: String(doc._id) });
});

router.delete('/personnel/:id', requireAnim, async (req,res)=>{
  const u = req.user;
  const id = req.params.id;
  const doc = await Teacher.findOne({ _id:id }).lean();
  if (!doc) return res.status(404).json({ error:'not found' });
  // sécurité: on limite la suppression à l’AP du même établissement/inspection
  if (String(doc.inspection) !== String(u.inspection).toLowerCase() || String(doc.etablissement)!==String(u.etab)) {
    return res.status(403).json({ error:'forbidden' });
  }
  await Teacher.deleteOne({ _id:id });
  res.json({ ok:true });
});

module.exports = router;
