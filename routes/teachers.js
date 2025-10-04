// routes/teachers.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer(); // mémoire
const Teacher = require('../models/Teacher');

const S = v => String(v||'').trim();
const L = v => S(v).toLowerCase();
const U = v => S(v).toUpperCase();
const splitList = v => S(v).split(/[|,;]/).map(s=>s.trim()).filter(Boolean);

function toDate(v){
  // accepte ISO, dd/mm/yyyy, yyyy-mm-dd
  const s = S(v);
  if(!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(m){
    const [ , d, mth, y ] = m.map(Number);
    const yyyy = y<100 ? (2000+y) : y;
    const dt = new Date(Date.UTC(yyyy, mth-1, d));
    return isNaN(dt) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(dt) ? null : dt;
}

/* ====== 1) Modèle CSV (en-têtes complets) ====== */
router.get('/template', (req, res)=>{
  const headers = [
    'Departement','DepartementCode','Specialite','Cycle',
    'Nom','Matricule','Grade','Categorie','DateNaissance','Sexe',
    'RegionOrigine','DepartementOrigine','ArrondissementOrigine',
    'DateEntreeFP','PosteOccupe','DateAffectation','RangPoste','Telephone',
    'Matiere','Statut','Classes','Disciplines','Observations'
  ];
  const csv = headers.join(';') + '\n';
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="modele_enseignants_complet.csv"');
  res.send(csv);
});

/* ====== 2) Import (CSV/XLSX) complet ====== */
const XLSX = require('xlsx');
function sheetRows(buf){
  const wb = XLSX.read(buf, { type:'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval:'' });
}

router.post('/import', upload.single('file'), async (req,res,next)=>{
  try{
    const u = req.user || {};
    const insp = L(u.inspection || 'artsplastiques');
    const etab = S(u.etab);
    const annee = S(req.body?.annee);
    if(!etab)  return res.status(403).json({ error:'Profil AP incomplet (etablissement manquant)' });
    if(!annee) return res.status(400).json({ error:'annee requise' });
    if(!req.file) return res.status(400).json({ error:'fichier requis (champ "file")' });

    const rows = sheetRows(req.file.buffer);
    const docs = rows.map(r => ({
      inspection: insp,
      etablissement: etab,
      annee,
      departement     : S(r.Departement),
      departementCode : S(r.DepartementCode),
      specialite      : U(r.Specialite),
      cycle           : L(r.Cycle), // '', 'premier', 'second'
      nom             : S(r.Nom),
      matricule       : S(r.Matricule),
      grade           : S(r.Grade),
      categorie       : S(r.Categorie),
      dateNaissance   : toDate(r.DateNaissance),
      sexe            : S(r.Sexe),
      regionOrigine        : S(r.RegionOrigine),
      departementOrigine   : S(r.DepartementOrigine),
      arrondissementOrigine: S(r.ArrondissementOrigine),
      dateEntreeFP     : toDate(r.DateEntreeFP),
      posteOccupe      : S(r.PosteOccupe),
      dateAffectation  : toDate(r.DateAffectation),
      rangPoste        : S(r.RangPoste),
      telephone        : S(r.Telephone),
      matiere          : S(r.Matiere),
      statut           : S(r.Statut || 'Enseignant'),
      classes          : splitList(r.Classes),
      disciplines      : splitList(r.Disciplines),
      observations     : S(r.Observations || r.Obs || ''),
      createdBy        : S(u.nom||'')
    })).filter(d => d.nom);

    const ops = docs.map(d => ({
      updateOne: {
        filter: { inspection:d.inspection, etablissement:d.etablissement, annee:d.annee, nom:d.nom },
        update: { $set: d },
        upsert: true
      }
    }));
    if(!ops.length) return res.json({ message:'Aucune ligne valide' });

    await Teacher.bulkWrite(ops, { ordered:false });
    res.json({ message:`Import enseignants: ${ops.length} upsert(s)` });
  }catch(e){ next(e); }
});

/* ====== 3) Liste & Upsert unitaire (pour la fiche) ====== */
router.get('/', async (req,res,next)=>{
  try{
    const u = req.user || {};
    const insp = L(u.inspection || 'artsplastiques');
    const etab = S(u.etab);
    const annee = S(req.query.annee);
    if(!etab)  return res.status(403).json({ error:'Profil AP incomplet (etablissement manquant)' });
    if(!annee) return res.status(400).json({ error:'annee requise' });
    const list = await Teacher.find({ inspection:insp, etablissement:etab, annee }).sort({ nom:1 }).lean();
    res.json(list);
  }catch(e){ next(e); }
});

router.post('/upsert', async (req,res,next)=>{
  try{
    const u = req.user || {};
    const insp = L(u.inspection || 'artsplastiques');
    const etab = S(u.etab);
    const body = req.body || {};
    const annee = S(body.annee);
    const nom   = S(body.nom);
    if(!etab)  return res.status(403).json({ error:'Profil AP incomplet (etablissement manquant)' });
    if(!annee || !nom) return res.status(400).json({ error:'annee et nom requis' });

    const data = {
      inspection: insp, etablissement: etab, annee,
      departement     : S(body.departement),
      departementCode : S(body.departementCode),
      specialite      : U(body.specialite),
      cycle           : L(body.cycle),
      nom,
      matricule       : S(body.matricule),
      grade           : S(body.grade),
      categorie       : S(body.categorie),
      dateNaissance   : toDate(body.dateNaissance),
      sexe            : S(body.sexe),
      regionOrigine        : S(body.regionOrigine),
      departementOrigine   : S(body.departementOrigine),
      arrondissementOrigine: S(body.arrondissementOrigine),
      dateEntreeFP     : toDate(body.dateEntreeFP),
      posteOccupe      : S(body.posteOccupe),
      dateAffectation  : toDate(body.dateAffectation),
      rangPoste        : S(body.rangPoste),
      telephone        : S(body.telephone),
      matiere          : S(body.matiere),
      statut           : S(body.statut || 'Enseignant'),
      classes          : Array.isArray(body.classes) ? body.classes.map(S).filter(Boolean) : splitList(body.classes),
      disciplines      : Array.isArray(body.disciplines) ? body.disciplines.map(S).filter(Boolean) : splitList(body.disciplines),
      observations     : S(body.observations || body.obs),
      createdBy        : S(u.nom||'')
    };

    await Teacher.updateOne(
      { inspection: insp, etablissement: etab, annee, nom },
      { $set: data },
      { upsert:true }
    );
    res.json({ ok:true, message:'Fiche enseignant enregistrée' });
  }catch(e){ next(e); }
});

module.exports = router;
