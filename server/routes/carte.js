const express = require('express');
const router = express.Router();
const { attachUser, requireAuth } = require('../middleware/auth'); // chemin OK depuis server/routes

// protège & injecte l’inspection
router.use(attachUser, requireAuth, (req, _res, next) => {
 req.insp = (req.user?.inspection || 'artsplastiques').toLowerCase();
next();
});
/* ===== Models ===== */
const Collecte = require('../../models/Collecte');
const Settings = require('../../models/Settings');
let Teacher = null; try { Teacher = require('../../models/Teacher'); } catch {}
let SchoolCard = null; try { SchoolCard = require('../../models/SchoolCard'); } catch {}

/* ===== utils ===== */
const TRI = { T1:[1,2], T2:[3,4], T3:[5,6] };
const norm = s => String(s ?? '').trim();
const { canonical, splitClassLabel } = require('../../utils/classes');
const n = (o, ...keys)=> { for(const k of keys){ const v=o?.[k]; if(v!==undefined && v!==null && String(v).trim?.()!=='') return Number(v)||0; } return 0; };
const pick = (o, ...keys)=> keys.reduce((s,k)=> s + (Number(o?.[k] ?? 0) || 0), 0);
const getDiscs = (c)=> Array.isArray(c?.disciplines) ? c.disciplines : (Array.isArray(c?.modules) ? c.modules : []);

/* ===== helpers ===== */
async function buildDeptMap(insp){
  const map = new Map(); // etab -> departement
  if (!SchoolCard) return map;

  // On tente les 2 structures : racine OU meta.*
  const rows = await SchoolCard.find({
    $or: [
      { inspection: insp },                // si champs à la racine
      { 'meta.inspection': insp }          // si champs dans meta.*
    ]
  })
  .select('etablissement departement meta')
  .lean()
  .catch(()=>[]);

  for (const r of rows){
    const etab = r.etablissement || r?.meta?.etablissement || '';
    const dept = r.departement  || r?.meta?.departement  || '—';
    if (etab) map.set(etab, dept);
  }
  return map;
}


/** Construit un dictionnaire {etab: {total, enPoste}} à partir de Teacher, sinon Settings.staff */
async function buildStaffCounts(insp, etabs){
  const counts = new Map(); // etab -> { total, enPoste }
  const setInc = (etab, isPoste) => {
    const c = counts.get(etab) || { total:0, enPoste:0 };
    c.total += 1;
    if (isPoste) c.enPoste += 1;
    counts.set(etab, c);
  };

  // 1) Teacher si dispo
  if (Teacher){
    try{
      const tRows = await Teacher.find({ etablissement: { $in: etabs } }).lean();
      for (const p of (tRows||[])){
        const etab = p.etablissement || '';
        if (!etab) continue;
        const statut = String(p.statut||'').toLowerCase();
        const isPoste = ['enseignant','en poste','titulaire','contractuel'].some(k => statut.includes(k));
        setInc(etab, isPoste);
      }
    }catch(_){}
  }

  // 2) Fallback Settings.staff pour les établissements qui n’ont rien
  const missing = etabs.filter(e => !counts.has(e));
  if (missing.length){
    const sRows = await Settings.find({ inspection: insp, etablissement: { $in: missing } })
      .select('etablissement staff').lean();
    for (const s of (sRows||[])){
      const etab = s.etablissement || '';
      for (const p of (s.staff||[])){
        const statut = String(p.statut||'').toLowerCase();
        const isPoste = ['enseignant','en poste','titulaire','contractuel'].some(k => statut.includes(k));
        setInc(etab, isPoste);
      }
    }
  }

  return counts;
}

/* =========================================================
   GET /api/carte/inspection
   ========================================================= */
router.get('/inspection', async (req,res,next)=>{
  try{
    const { annee, evaluation, trimestre, cycle, specialite } = req.query;
    const f = { inspection: req.insp };
    if (annee)      f.annee = String(annee);
    if (cycle)      f.cycle = String(cycle);
    if (specialite) f.specialite = String(specialite).toUpperCase();
    if (evaluation) f.evaluation = Number(evaluation);
    else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

    const deptMap = await buildDeptMap(req.insp);
    const fiches = await Collecte.find(f).lean();

    const byEtab = new Map();
    const byDept = new Map();
    const classesAgg = new Map(); // classe -> {classe, filles, garcons}

    const region = { ap:new Set(), apNoms:new Set(), filles:0, garcons:0, EfT:0, EfP:0, classes:new Set() };

    const getDept = (etab, fallback) => deptMap.get(etab) || fallback || '—';
    const upGenderFromClass=(T,c)=>{ T.filles=(T.filles||0)+pick(c,'filles','Filles','f','F'); T.garcons=(T.garcons||0)+pick(c,'garcons','Garcons','g','G'); };
    const upGenderFromDisc =(T,d)=>{ T.filles=(T.filles||0)+pick(d,'filles','Filles','f','F'); T.garcons=(T.garcons||0)+pick(d,'garcons','Garcons','g','G'); };

    for (const F of fiches){
      const etab = F.etablissement || '—';
      const dept = getDept(etab, F.departement);

      if (!byEtab.has(etab)) byEtab.set(etab, {
        etablissement: etab, departement: dept,
        cyclesOuverts:new Set(), classesOuvertes:new Set(), apSet:new Set(),
        filles:0, garcons:0, EfT:0, EfP:0, depots:[], evals:new Set()
      });
      const E = byEtab.get(etab);

      E.cyclesOuverts.add(F.cycle);
      if (F.animateur){ E.apSet.add(F.animateur); region.ap.add(F.animateur); region.apNoms.add(F.animateur); }
      E.depots.push({ id:String(F._id), evaluation:F.evaluation, createdAt:F.createdAt });
      if (F.evaluation!=null) E.evals.add(Number(F.evaluation));

      (F.classes||[]).forEach(c=>{
 const cnameFull = norm(c.nom);
const cname = canonical(cnameFull);  // ← on garde la base
if (cname){ E.classesOuvertes.add(cname); region.classes.add(cname); }
        upGenderFromClass(E,c); upGenderFromClass(region,c);
        getDiscs(c).forEach(d=>{
          E.EfT+=n(d,'effTot','EffT','ensTot'); E.EfP+=n(d,'effPos','EffP','ensPoste');
          region.EfT+=n(d,'effTot','EffT','ensTot'); region.EfP+=n(d,'effPos','EffP','ensPoste');
          upGenderFromDisc(E,d); upGenderFromDisc(region,d);
        });
         if (cname){
         const agg = classesAgg.get(cname) || { classe:cname, filles:0, garcons:0, total:0 };
          agg.filles  += pick(c,'filles','Filles','f','F');
          agg.garcons += pick(c,'garcons','Garcons','g','G');
          classesAgg.set(cname, agg);
        }
      });

      if (!byDept.has(dept)) byDept.set(dept, {
        departement:dept, etabSet:new Set(), apSet:new Set(), apNoms:new Set(),
        classesSet:new Set(), filles:0, garcons:0, EfT:0, EfP:0
      });
      const D = byDept.get(dept);
      D.etabSet.add(etab);
      if (F.animateur){ D.apSet.add(F.animateur); D.apNoms.add(F.animateur); }
      D.filles  += pick(E,'filles'); D.garcons += pick(E,'garcons');
      D.EfT     += pick(E,'EfT');   D.EfP     += pick(E,'EfP');
      E.classesOuvertes.forEach(cn=>D.classesSet.add(cn));
    }

    // Comptes staff (Teacher / Settings) pour KPI fiables
    const allEtabs = Array.from(byEtab.keys());
    const staffCounts = await buildStaffCounts(req.insp, allEtabs);

    // rows (établissements)
    const rows = Array.from(byEtab.values()).map(E=>{
      const cycles  = Array.from(E.cyclesOuverts).sort();
      const classes = Array.from(E.classesOuvertes).sort();
      const apList  = Array.from(E.apSet).sort();
      const filles  = E.filles, garcons=E.garcons, eleves=(filles+garcons);
      const evals   = Array.from(E.evals).sort((a,b)=>a-b);
      const missing = [1,2,3,4,5,6].filter(x=>!evals.includes(x));

      // Remplace EfT/EfP par staff si dispo
      const sc = staffCounts.get(E.etablissement);
      const enseignantsTotaux  = sc ? sc.total  : E.EfT;
      const enseignantsEnPoste = sc ? sc.enPoste: E.EfP;

      return {
        etablissement:E.etablissement, departement:E.departement,
        cyclesOuverts:cycles, classesOuvertes:classes,
        apList, apActifs:apList.length,
        filles, garcons, eleves,
        enseignantsTotaux, enseignantsEnPoste,
        evaluations:evals, evaluationsManquantes:missing,
        depots: E.depots.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt))
      };
    }).sort((a,b)=> a.etablissement.localeCompare(b.etablissement));

    // byDept (tableau) – agrégation à partir de rows (qui contiennent déjà les bons comptes staff)
    const byDeptRows = Array.from(byDept.values()).map(D=>{
      const etabList = Array.from(D.etabSet).sort();
      const rowsDept = rows.filter(r => etabList.includes(r.etablissement));
      return {
        departement: D.departement,
        etablissements: etabList.length,
        etabList,
        apActifs: D.apSet.size,
        apNoms: Array.from(D.apNoms).sort(),
        filles: rowsDept.reduce((s,r)=>s+r.filles,0),
        garcons: rowsDept.reduce((s,r)=>s+r.garcons,0),
        eleves:  rowsDept.reduce((s,r)=>s+r.eleves,0),
        enseignantsTotaux:  rowsDept.reduce((s,r)=>s+r.enseignantsTotaux,0),
        enseignantsEnPoste: rowsDept.reduce((s,r)=>s+r.enseignantsEnPoste,0),
        classesOuvertes: Array.from(D.classesSet).sort()
      };
    }).sort((a,b)=> String(a.departement).localeCompare(String(b.departement)));

    // region pack
    // set global unique AP (depuis rows)
const apGlob = new Set();
rows.forEach(r => (r.apList||[]).forEach(a => apGlob.add(a)));

const regionPack = {
  etablissements     : rows.length,
  apActifs           : apGlob.size,   // ← corrige le double comptage
  apNoms             : Array.from(apGlob).sort(),
  filles             : byDeptRows.reduce((s,d)=> s + d.filles, 0),
  garcons            : byDeptRows.reduce((s,d)=> s + d.garcons, 0),
  eleves             : byDeptRows.reduce((s,d)=> s + d.eleves, 0),
  enseignantsTotaux  : byDeptRows.reduce((s,d)=> s + d.enseignantsTotaux, 0),
  enseignantsEnPoste : byDeptRows.reduce((s,d)=> s + d.enseignantsEnPoste, 0),
  classesOuvertes    : Array.from(new Set([].concat(...byDeptRows.map(d=>d.classesOuvertes)))).sort()
};


    // classes agrégées (région)
    const classesAggRows = Array.from(classesAgg.values())
      .map(x => ({ classe:x.classe, filles:x.filles, garcons:x.garcons, total:(x.filles+x.garcons) }))
      .sort((a,b)=> String(a.classe).localeCompare(String(b.classe)));

    // menu explorateur
    const explorer = {
      depts: byDeptRows.map(d => ({ key:d.departement||'—', label:d.departement||'—', etabs:d.etabList }))
    };

    res.json({ region:regionPack, byDept:byDeptRows, classesAgg:classesAggRows, rows, explorer });
  }catch(e){ next(e); }
});

/* =========================================================
   GET /api/carte/etab?etablissement=XYZ
   ========================================================= */
router.get('/etab', async (req,res,next)=>{
  try{
    const etab = String(req.query.etablissement||'').trim();
    if(!etab) return res.status(400).json({ error:'etablissement requis' });

    const last = await Collecte.findOne({ inspection:req.insp, etablissement:etab })
      .sort({ createdAt:-1 }).lean();

    const deptMap = await buildDeptMap(req.insp);
    const departement = deptMap.get(etab) || last?.departement || '—';

    // Effectifs (préférence Settings.effectifs)
    let effectifs = [];
    const S = await Settings.findOne({ inspection:req.insp, etablissement:etab, annee:last?.annee }).lean();
    if (Array.isArray(S?.effectifs) && S.effectifs.length){
      effectifs = S.effectifs.map(e=>({ classe:norm(e.classe), filles:Number(e.filles||0), garcons:Number(e.garcons||0) }))
        .filter(x=>x.classe);
    }else{
      const fiches = await Collecte.find({ inspection:req.insp, etablissement:etab, annee:last?.annee }).lean();
      const byC = new Map();
      fiches.forEach(F=> (F.classes||[]).forEach(c=>{
        const name = canonical(norm(c.nom)); if(!name) return;
        const row = byC.get(name) || { classe:name, filles:0, garcons:0 };
        row.filles  += pick(c,'filles','Filles','f','F');
        row.garcons += pick(c,'garcons','Garcons','g','G');
        getDiscs(c).forEach(d=>{ row.filles+=pick(d,'filles','Filles','f','F'); row.garcons+=pick(d,'garcons','Garcons','g','G'); });
        byC.set(name,row);
      }));
      effectifs = Array.from(byC.values()).sort((a,b)=> a.classe.localeCompare(b.classe));
    }

    // AP + classes ouvertes + dépôts (année courante)
    const docs = await Collecte.find({ inspection:req.insp, etablissement:etab, annee:last?.annee }).lean();
    const uniqSorted = arr => Array.from(new Set(arr.filter(Boolean))).sort((a,b)=> String(a).localeCompare(String(b)));
    const ap = uniqSorted(docs.map(d=>d.animateur).filter(Boolean));
    const classes = uniqSorted(docs.flatMap(d=> (d.classes||[]).map(c=> norm(c.nom))).filter(Boolean));

    const received = docs.map(d=>({ id:String(d._id), evaluation:d.evaluation, createdAt:d.createdAt }))
                         .sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    const done = uniqSorted(received.map(r=> Number(r.evaluation||0)).filter(Boolean).map(Number));
    const missing = [1,2,3,4,5,6].filter(x=> !done.includes(x));

    // Staff
    let staff = [];
    if (Teacher){
      try{
        const rows = await Teacher.find({ etablissement: etab, annee: last?.annee }).lean();
        staff = rows.map(p => ({
          nom: p.nomComplet || p.nom || '',
          grade: p.grade || '',
          matiere: p.matiere || p.discipline || '',
          statut: p.statut || '',
          classes: Array.isArray(p.classes) ? p.classes : [],
          disciplines: Array.isArray(p.disciplines) ? p.disciplines : [],
          obs: p.obs || p.observations || ''
        }));
      }catch(_){}
    }
    if (!staff.length && Array.isArray(S?.staff) && S.staff.length){
      staff = S.staff.map(s => ({
        nom: s.nom || '',
        grade: s.grade || '',
        matiere: s.matiere || '',
        statut: s.statut || '',
        classes: Array.isArray(s.classes) ? s.classes : [],
        disciplines: Array.isArray(s.disciplines) ? s.disciplines : [],
        obs: s.obs || ''
      }));
    }

    res.json({
      meta: { etablissement: etab, departement, annee: last?.annee || '', cycle: last?.cycle || '', specialite: last?.specialite || '' },
      ap, classesOuvertes: classes,
      effectifs, staff,
      depots: { received, missing, totalExpected: 6 }
    });
  }catch(e){ next(e); }
});

/* =========================================================
   GET /api/carte/region-staff[?departement=XX]
   ========================================================= */
router.get('/region-staff', async (req,res,next)=>{
  try{
    const { departement } = req.query;
    const deptMap = await buildDeptMap(req.insp);
    const allEtabs = await Collecte.distinct('etablissement', { inspection:req.insp }).lean();

    // Teacher
    let tRows = [];
    if (Teacher){
      try{
        const list = await Teacher.find({ etablissement: { $in: allEtabs } }).lean();
        tRows = list.map(p => ({
          etablissement: p.etablissement || '',
          departement : deptMap.get(p.etablissement || '') || '—',
          nom         : p.nomComplet || p.nom || '',
          grade       : p.grade || '',
          matiere     : p.matiere || p.discipline || '',
          statut      : p.statut || '',
          classes     : (p.classes||[]).join(' / '),
          disciplines : (p.disciplines||[]).join(' / '),
          obs         : p.obs || p.observations || ''
        }));
      }catch(_){}
    }

    // Fallback Settings.staff
    const sRows = await Settings.find({ inspection:req.insp, etablissement: { $in: allEtabs } })
      .select('etablissement staff').lean();
    const sMapped = [];
    for (const s of (sRows||[])){
      const etab = s.etablissement || '';
      const hasTeacher = tRows.some(r => r.etablissement === etab);
      if (!hasTeacher){
        for (const p of (s.staff||[])){
          sMapped.push({
            etablissement: etab,
            departement : deptMap.get(etab) || '—',
            nom         : p.nom || '',
            grade       : p.grade || '',
            matiere     : p.matiere || '',
            statut      : p.statut || '',
            classes     : (p.classes||[]).join(' / '),
            disciplines : (p.disciplines||[]).join(' / '),
            obs         : p.obs || ''
          });
        }
      }
    }

    const out = [...tRows, ...sMapped];
    const filtered = departement ? out.filter(r => r.departement === departement) : out;
    res.json({ rows: filtered.sort((a,b)=> a.etablissement.localeCompare(b.etablissement)) });
  }catch(e){ next(e); }
});

module.exports = router;
