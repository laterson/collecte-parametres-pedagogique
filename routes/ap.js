// routes/ap.js
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');

const Collecte = require('../models/Collecte');
const Teacher  = require('../models/Teacher');
const Settings = require('../models/Settings');
const Baseline = require('../models/Baseline');

const { scopedForAP } = require('../server/utils/ap-scope');

/* ========= Utils ========= */
const norm = s => String(s ?? '').trim();
const S    = v => String(v || '').trim();
const n = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim()!=='') return Number(v) || 0;
  }
  return 0;
};
const getDiscs = (c)=> Array.isArray(c?.disciplines) ? c.disciplines : (Array.isArray(c?.modules) ? c.modules : []);
async function safeUnlink(abs){
  try { await fs.promises.rm(abs, { force:true }); } catch(_e){}
}

/* ========= GUARD: AP connecté ========= */
function requireAnim(req, res, next){
  if (!req.user) return res.status(401).json({ error:'auth required' });
  if (!['anim','admin'].includes(req.user.role)) return res.status(403).json({ error:'forbidden' });
  next();
}

/* =========================================================================
 *  A) EFFECTIFS PAR CLASSE (filles / garçons)
 * =========================================================================
 */

// GET lecture des effectifs saisis (préremplissage panneau AP)
router.get('/effectifs', requireAnim, async (req,res,next)=>{
  try{
    const { annee, cycle, specialite, evaluation } = req.query||{};
    if (!annee || !cycle || !specialite || !evaluation) {
      return res.status(400).json({ error:'annee, cycle, specialite, evaluation requis' });
    }

    // filtre cloisonné AP + inspection
    const f = scopedForAP(req, {
      annee      : String(annee).trim(),
      cycle      : String(cycle).trim(),
      specialite : String(specialite).toUpperCase(),
      evaluation : Number(evaluation)
    });

    const doc = await Collecte.findOne(f).lean();

    // garde-fou (défensif)
    if (doc && (String(doc.etablissement)!==String(req.user.etab)
             || String(doc.inspection).toLowerCase() !== String(req.user.inspection).toLowerCase())) {
      return res.status(403).json({ error:'scope leak detected' });
    }

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
  }catch(e){ next(e); }
});

// POST upsert des effectifs saisis par classe
router.post('/effectifs', requireAnim, async (req,res,next)=>{
  try{
    const u = req.user;
    const { annee, cycle, specialite, evaluation, items=[] } = req.body||{};
    if (!annee || !cycle || !specialite || !evaluation) {
      return res.status(400).json({ error:'annee, cycle, specialite, evaluation requis' });
    }

    // filtre cloisonné
    const F = scopedForAP(req, {
      annee      : String(annee),
      cycle      : String(cycle),
      specialite : String(specialite).toUpperCase(),
      evaluation : Number(evaluation)
    });

    // upsert du document de collecte concerné
    let doc = await Collecte.findOne(F);
    if (!doc) {
      doc = new Collecte({
        ...F,
        // on renforce encore l’appartenance
        inspection   : (u.inspection||'artsplastiques').toLowerCase(),
        etablissement: u.etab,
        animateur    : u.nom || u.email || '',
        classes      : []
      });
    } else {
      // garde-fou lecture/écriture
      if (String(doc.etablissement)!==String(u.etab)
       || String(doc.inspection).toLowerCase() !== String(u.inspection).toLowerCase()){
        return res.status(403).json({ error:'forbidden: wrong document scope' });
      }
    }

    // MàJ classes[].filles/garcons
    const wantedMap = new Map();
    (Array.isArray(items) ? items : []).forEach(it=>{
      const key = norm(it.classe);
      if (!key) return;
      wantedMap.set(key, { filles:Number(it.filles||0), garcons:Number(it.garcons||0) });
    });

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

    // renforce (au cas où doc existant serait incomplet)
    doc.inspection   = (u.inspection||'artsplastiques').toLowerCase();
    doc.etablissement= u.etab;

    await doc.save();
    res.json({ ok:true, updated: wantedMap.size });
  }catch(e){ next(e); }
});


/* =========================================================================
 *  B) PERSONNEL ENSEIGNANT
 * =========================================================================
 */

// GET liste personnel AP
router.get('/personnel', requireAnim, async (req,res,next)=>{
  try{
    const annee = String(req.query.annee||'').trim();
    if (!annee) return res.status(400).json({ error:'annee requis' });

    // filtre cloisonné
    const f = scopedForAP(req, { annee });
    const rows = await Teacher.find(f).sort({ nom:1 }).lean();

    // garde-fou (défensif)
    const bad = rows.find(r => String(r.etablissement)!==String(req.user.etab)
                            || String(r.inspection).toLowerCase() !== String(req.user.inspection).toLowerCase());
    if (bad) return res.status(403).json({ error:'scope leak detected' });

    const q = (req.query.q||'').toString().toLowerCase();
    const filtered = q
      ? rows.filter(r=>{
          const blob = [r.nom,r.grade,r.matiere,(r.classes||[]).join(','),(r.disciplines||[]).join(','),r.statut]
            .join(' ')
            .toLowerCase();
          return blob.includes(q);
        })
      : rows;

    res.json({ rows: filtered });
  }catch(e){ next(e); }
});

// POST upsert d’un enseignant (clé unique par inspection/etab/annee/nom)
router.post('/personnel', requireAnim, async (req,res,next)=>{
  try{
    const u = req.user;

    // ➜ on récupère aussi specialite & cycle pour remplir l’en-tête
    const {
      annee, nom,
      grade = '', matiere = '', statut = 'Enseignant',
      classes = [], disciplines = [], observations = '',
      specialite = '', cycle = ''
    } = req.body || {};

    if (!annee || !nom) return res.status(400).json({ error:'annee & nom requis' });

    // clé + renforcement scope
    const key = scopedForAP(req, {
      annee : String(annee),
      nom   : String(nom).trim()
    });

    const payload = {
      ...key,

      // ==== EN-TÊTE ORGANISATIONNEL (NOUVEAU) ====
      departement     : u.departement || '',
      departementCode : u.departementCode || '',
      specialite      : String(specialite || u.specialite || '').toUpperCase().trim(),
      cycle           : String(cycle || '').trim(),

      // ==== Identité / pédagogie ====
      grade: String(grade||'').trim(),
      matiere: String(matiere||'').trim(),
      statut: String(statut||'').trim(),
      classes: Array.isArray(classes) ? classes.map(String) : [],
      disciplines: Array.isArray(disciplines) ? disciplines.map(String) : [],
      observations: String(observations||'').trim(),

      createdBy: u.email || u.nom || ''
    };

    const doc = await Teacher.findOneAndUpdate(
      key,
      { $set: payload },
      { upsert:true, new:true, setDefaultsOnInsert:true }
    );

    // garde-fou
    if (String(doc.etablissement)!==String(u.etab)
     || String(doc.inspection).toLowerCase() !== String(u.inspection).toLowerCase()){
      return res.status(403).json({ error:'scope leak detected' });
    }

    res.json({ ok:true, id:String(doc._id) });
  }catch(e){ next(e); }
});

// POST bulk upsert (importer tout le fichier des enseignants en une fois)
router.post('/personnel/bulk', requireAnim, async (req,res,next)=>{
  try{
    const u = req.user;
    const { annee, specialite = '', cycle = '', rows = [] } = req.body || {};
    if (!annee) return res.status(400).json({ error:'annee requis' });
    if (!Array.isArray(rows) || !rows.length) return res.json({ ok:true, inserted:0, updated:0 });

    let inserted = 0, updated = 0;

    for (const r of rows){
      const nom = String(r.nom || r.name || '').trim();
      if (!nom) continue;

      const key = scopedForAP(req, {
        annee: String(annee),
        nom
      });

      const payload = {
        ...key,

        // ==== EN-TÊTE ORGANISATIONNEL (NOUVEAU) ====
        departement     : u.departement || r.departement || '',
        departementCode : u.departementCode || r.departementCode || '',
        specialite      : String(r.specialite || specialite || u.specialite || '').toUpperCase().trim(),
        cycle           : String(r.cycle || cycle || '').trim(),

        // ==== Champs RH / identité (si présents dans le fichier) ====
        matricule       : String(r.matricule || '').trim(),
        categorie       : String(r.categorie || '').trim(),
        dateNaissance   : r.dateNaissance ? new Date(r.dateNaissance) : (r.naissance ? new Date(r.naissance) : null),
        sexe            : String(r.sexe || r.genre || '').trim(),

        regionOrigine        : String(r.regionOrigine || '').trim(),
        departementOrigine   : String(r.departementOrigine || '').trim(),
        arrondissementOrigine: String(r.arrondissementOrigine || '').trim(),

        dateEntreeFP    : r.dateEntreeFP ? new Date(r.dateEntreeFP) : null,
        posteOccupe     : String(r.posteOccupe || '').trim(),
        dateAffectation : r.dateAffectation ? new Date(r.dateAffectation) : null,
        rangPoste       : String(r.rangPoste || '').trim(),
        telephone       : String(r.telephone || r.contact || '').trim(),

        // ==== Pédagogie locale (compat) ====
        grade      : String(r.grade || '').trim(),
        matiere    : String(r.matiere || '').trim(),
        statut     : String(r.statut || 'Enseignant').trim(),
        classes    : Array.isArray(r.classes) ? r.classes.map(String) : [],
        disciplines: Array.isArray(r.disciplines) ? r.disciplines.map(String) : [],
        observations: String(r.observations || r.obs || '').trim(),

        createdBy: u.email || u.nom || ''
      };

      const before = await Teacher.findOne(key).select('_id updatedAt').lean();
      const doc = await Teacher.findOneAndUpdate(key, { $set: payload }, { upsert:true, new:true, setDefaultsOnInsert:true });

      if (!before) inserted++;
      else if (before && (doc.updatedAt && before.updatedAt && doc.updatedAt.getTime() !== new Date(before.updatedAt).getTime())) updated++;
    }

    res.json({ ok:true, inserted, updated });
  }catch(e){ next(e); }
});




router.delete('/personnel/:id', requireAnim, async (req,res,next)=>{
  try{
    const u = req.user;
    const id = req.params.id;
    const doc = await Teacher.findOne({ _id:id }).lean();
    if (!doc) return res.status(404).json({ error:'not found' });
    // sécurité: on limite la suppression à l’AP du même établissement/inspection
    if (String(doc.inspection).toLowerCase() !== String(u.inspection).toLowerCase()
     || String(doc.etablissement)!==String(u.etab)) {
      return res.status(403).json({ error:'forbidden' });
    }
    await Teacher.deleteOne({ _id:id });
    res.json({ ok:true });
  }catch(e){ next(e); }
});


/* =========================================================================
 *  C) PURGE DES DONNÉES (AP)
 *     - scope strict: inspection + établissement de l'utilisateur
 *     - annee facultative
 * =========================================================================
 */

// Aperçu (dry-run)
// GET /api/ap/purge/preview?annee=2024
router.get('/purge/preview', requireAnim, async (req,res,next)=>{
  try{
    const u     = req.user || {};
    const insp  = S(u.inspection || 'artsplastiques').toLowerCase();
    const etab  = S(u.etab);
    const annee = S(req.query.annee);
    if (!etab) return res.status(403).json({ error:'Profil AP incomplet (etablissement manquant)' });

    const fSettings = { inspection: insp, etablissement: etab, ...(annee ? { annee } : {}) };
    const fBaseline = { etablissement: etab, ...(annee ? { annee } : {}) };
    const fCollecte = { inspection: insp, etablissement: etab, ...(annee ? { annee } : {}) };
    const fTeacher  = { inspection: insp, etablissement: etab, ...(annee ? { annee } : {}) };

    const [cSet, cBase, cCol, cTeach] = await Promise.all([
      Settings.countDocuments(fSettings),
      Baseline.countDocuments(fBaseline),
      Collecte.countDocuments(fCollecte),
      Teacher.countDocuments(fTeacher)
    ]);

    // recensement des fichiers (relatifs) depuis les collectes
    const docs = await Collecte.find(fCollecte).select('fichiers uploads pieces').lean();
    const filePaths = [];
    for (const d of docs){
      const all = []
        .concat(d.pieces || [])
        .concat(d.fichiers || [])
        .concat(d.uploads || [])
        .filter(Boolean);
      for (const f of all){
        if (typeof f === 'string') filePaths.push(f);
        else {
          const p = f.path || f.url || '';
          if (p) filePaths.push(p);
        }
      }
    }

    res.json({
      scope: { inspection: insp, etablissement: etab, annee: annee || '(toutes)' },
      counts: { settings:cSet, baselines:cBase, collectes:cCol, teachers:cTeach, files:filePaths.length },
      samples: filePaths.slice(0,10)
    });
  }catch(e){ next(e); }
});

// Purge effective
// POST /api/ap/purge  body: { annee?: "2024", confirm: "<nom-etablissement>" }
router.post('/purge', requireAnim, async (req,res,next)=>{
  try{
    const u      = req.user || {};
    const insp   = S(u.inspection || 'artsplastiques').toLowerCase();
    const etab   = S(u.etab);
    const annee  = S(req.body?.annee);
    const confirm= S(req.body?.confirm);
    if (!etab) return res.status(403).json({ error:'Profil AP incomplet (etablissement manquant)' });
    if (confirm.toLowerCase() !== etab.toLowerCase()){
      return res.status(400).json({ error:'Confirmez en saisissant exactement le nom de votre établissement.' });
    }

    const fSettings = { inspection: insp, etablissement: etab, ...(annee ? { annee } : {}) };
    const fBaseline = { etablissement: etab, ...(annee ? { annee } : {}) };
    const fCollecte = { inspection: insp, etablissement: etab, ...(annee ? { annee } : {}) };
    const fTeacher  = { inspection: insp, etablissement: etab, ...(annee ? { annee } : {}) };

    // chemins des fichiers à supprimer
    const docs = await Collecte.find(fCollecte).select('fichiers uploads pieces').lean();
    const rels = [];
    for (const d of docs){
      const all = []
        .concat(d.pieces || [])
        .concat(d.fichiers || [])
        .concat(d.uploads || [])
        .filter(Boolean);
      for (const f of all){
        const p = typeof f === 'string' ? f : (f.path || f.url || '');
        if (p) rels.push(p.replace(/^\/+/, ''));
      }
    }

    // suppressions en base
    const [rSet, rBase, rCol, rTeach] = await Promise.all([
      Settings.deleteMany(fSettings),
      Baseline.deleteMany(fBaseline),
      Collecte.deleteMany(fCollecte),
      Teacher.deleteMany(fTeacher) // si tu préfères conserver les enseignants, commente cette ligne
    ]);

    // suppression physique des fichiers sous /uploads
    const root = path.join(process.cwd(), 'uploads');
    let removedFiles = 0;
    for (const rel of rels){
      const abs = path.resolve(root, rel);
      if (abs.startsWith(root)) { await safeUnlink(abs); removedFiles++; }
    }

    res.json({
      ok:true,
      scope: { inspection: insp, etablissement: etab, annee: annee || '(toutes)' },
      deleted: {
        settings: rSet.deletedCount || 0,
        baselines: rBase.deletedCount || 0,
        collectes: rCol.deletedCount || 0,
        teachers: rTeach.deletedCount || 0,
        files: removedFiles
      }
    });
  }catch(e){ next(e); }
});

module.exports = router;
