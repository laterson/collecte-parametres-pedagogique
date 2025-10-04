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

// normalisation robuste pour les clés d'établissement (clé d’agrégat)
const normEtab = s => String(s||'')
  .normalize('NFD').replace(/\p{Diacritic}/gu,'') // enlève accents
  .replace(/\u00A0/g,' ').replace(/\s+/g,' ')     // espaces propres
  .trim().toLowerCase();
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

// --- helper générique pour dédoublonner ---
function uniqBy(arr, keyFn){
  const seen = new Set();
  const out = [];
  for (const x of (arr || [])) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}



/** Construit un dictionnaire {etab: {total, enPoste}} à partir de Teacher, sinon Settings.staff */
async function buildStaffCounts(insp, etabs, annee){
 const want = new Set(etabs.map(normEtab));   // périmètre normalisé
  const counts = new Map(); // etab -> { total, enPoste }
 const setInc = (etab /*, isPoste */) => {
    const key = normEtab(etab);
    if (!want.has(key)) return;                 // hors périmètre
    const c = counts.get(key) || { total:0, enPoste:0 };
    c.total += 1;
    c.enPoste = c.total;                        // règle: en poste = total
    counts.set(key, c);
  };

  // 1) Teacher si dispo
  if (Teacher){
    try{
     // APRÈS (robuste aux différences d'accents/espaces/casse)
const tQuery = annee ? { annee: String(annee) } : {};
     const tRows = await Teacher.find(tQuery).lean();
for (const p of (tRows || [])) {
  const key = normEtab(p?.etablissement || '');
  if (!key) continue;
  if (!want.has(key)) continue;          // périmètre Collecte (inspection courante)
  setInc(p.etablissement);               // setInc normalise déjà et aligne enPoste=total
}

    }catch(_){}
  }

 // 2) Fallback Settings.staff pour les établissements qui n’ont rien
// ❗ Ne PAS filtrer avec $in sur des noms normalisés — on récupère tout puis on filtre en JS.
const sQuery = annee ? { inspection: insp, annee: String(annee) } : { inspection: insp };
 const sRows = await Settings.find(sQuery)
  .select('etablissement staff')
  .lean();

for (const s of (sRows || [])) {
  const rawEtab = s?.etablissement;
  if (!rawEtab) continue;

  const key = normEtab(rawEtab);      // même clé que 'want' et 'counts'
  // Seulement si l'établissement est dans le périmètre et qu'on n'a rien compté via Teacher
  if (!want.has(key) || counts.has(key)) continue;

  const nStaff = Array.isArray(s.staff) ? s.staff.length : 0;
  if (nStaff > 0) {
    // "en poste" = "total" (règle demandée)
    counts.set(key, { total: nStaff, enPoste: nStaff });
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
  if (F.animateur){ 
    E.apSet.add(F.animateur); 
    region.ap.add(F.animateur); 
    region.apNoms.add(F.animateur); 
  }
  E.depots.push({ id:String(F._id), evaluation:F.evaluation, createdAt:F.createdAt });
  if (F.evaluation!=null) E.evals.add(Number(F.evaluation));

  // ======= RÈGLE DE PRIORITÉ pour éviter les doubles comptages =======
  // Si le dépôt contient un tableau effectifs[], on l'utilise EXCLUSIVEMENT
  // pour les F/G et les classes ouvertes. Sinon, on retombe sur classes[].
  const useDepotEff = Array.isArray(F.effectifs) && F.effectifs.length > 0;

  if (useDepotEff) {
    // --- 1) Compter les effectifs depuis F.effectifs
    (F.effectifs || []).forEach(e => {
      const f = Number(e.filles || 0);
      const g = Number(e.garcons || 0);

      // KPIs établissement & région (F/G)
      E.filles += f;  E.garcons += g;
      region.filles += f; region.garcons += g;

      // classes ouvertes + agrégat par classe (région)
      const cname = canonical(norm(e.classe));
      if (cname) {
        E.classesOuvertes.add(cname);
        region.classes.add(cname);

        const agg = classesAgg.get(cname) || { classe:cname, filles:0, garcons:0, total:0 };
        agg.filles  += f;
        agg.garcons += g;
        classesAgg.set(cname, agg);
      }
    });

    // --- 2) On peut quand même récupérer les EfT/EfP via disciplines s'il y en a
    (F.classes || []).forEach(c => {
      getDiscs(c).forEach(d => {
        E.EfT     += n(d,'effTot','EffT','ensTot');
        E.EfP     += n(d,'effPos','EffP','ensPoste');
        region.EfT+= n(d,'effTot','EffT','ensTot');
        region.EfP+= n(d,'effPos','EffP','ensPoste');
      });
    });

  } else {
    // --- Fallback: ancien schéma basé sur F.classes
    (F.classes||[]).forEach(c=>{
      // F/G au niveau de la classe
      const f = pick(c,'filles','Filles','f','F');
      const g = pick(c,'garcons','Garcons','g','G');

      E.filles += f;  E.garcons += g;
      region.filles += f; region.garcons += g;

      // classes ouvertes
      const cnameFull = norm(c.nom);
      const cname = canonical(cnameFull);
      if (cname){ 
        E.classesOuvertes.add(cname); 
        region.classes.add(cname); 
      }

      // Disciplines : EfT / EfP (+ éventuellement F/G si fournis au niveau discipline)
      getDiscs(c).forEach(d=>{
        E.EfT     += n(d,'effTot','EffT','ensTot'); 
        E.EfP     += n(d,'effPos','EffP','ensPoste');
        region.EfT+= n(d,'effTot','EffT','ensTot'); 
        region.EfP+= n(d,'effPos','EffP','ensPoste');

        const df = pick(d,'filles','Filles','f','F');
        const dg = pick(d,'garcons','Garcons','g','G');
        if (df || dg){
          E.filles += df;  E.garcons += dg;
          region.filles += df; region.garcons += dg;
        }
      });

      // Agrégat par classe (région)
      if (cname){
        const agg = classesAgg.get(cname) || { classe:cname, filles:0, garcons:0, total:0 };
        agg.filles  += f;
        agg.garcons += g;
        classesAgg.set(cname, agg);
      }
    });
  }
  // ======= fin règle de priorité =======



     if (!byDept.has(dept)) byDept.set(dept, {
   departement: dept,
   etabSet: new Set(),
   apSet: new Set(),
   apNoms: new Set(),
   classesSet: new Set()
 });
      const D = byDept.get(dept);
      D.etabSet.add(etab);
      if (F.animateur){ D.apSet.add(F.animateur); D.apNoms.add(F.animateur); }
     
      E.classesOuvertes.forEach(cn=>D.classesSet.add(cn));
    }

    // Comptes staff (Teacher / Settings) pour KPI fiables
    const allEtabs = Array.from(byEtab.keys());
    const staffCounts = await buildStaffCounts(req.insp, allEtabs, annee);

    // rows (établissements)
    const rows = Array.from(byEtab.values()).map(E=>{
      const cycles  = Array.from(E.cyclesOuverts).sort();
      const classes = Array.from(E.classesOuvertes).sort();
      const apList  = Array.from(E.apSet).sort();
      const filles  = E.filles, garcons=E.garcons, eleves=(filles+garcons);
      const evals   = Array.from(E.evals).sort((a,b)=>a-b);
      const missing = [1,2,3,4,5,6].filter(x=>!evals.includes(x));

      // Source staff (Teacher/Settings) si dispo, sinon EfT/EfP.
      // ⚠ Exigence: "en poste" == total (on aligne volontairement)
    const sc = staffCounts.get(normEtab(E.etablissement)) || { total: E.EfT, enPoste: E.EfP };
      const enseignantsTotaux  = sc.total;
     const enseignantsEnPoste = sc.total; // ← aligné sur le total
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
   const etab  = String(req.query.etablissement||'').trim();
  const annee = req.query.annee ? String(req.query.annee) : null;
    if(!etab) return res.status(400).json({ error:'etablissement requis' });

   const last = await Collecte.findOne({ inspection:req.insp, etablissement:etab, ...(annee ? { annee } : {}) })
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
  // --- Reconstruction SANS double comptage ---
  const fiches = await Collecte.find({ inspection:req.insp, etablissement:etab, annee:last?.annee }).lean();
  const byC = new Map();

  // Règle: si un dépôt F a "effectifs[]", on PREND ça et on IGNORE filles/garcons dans F.classes
  for (const F of (fiches || [])) {
    const hasDepotEff = Array.isArray(F.effectifs) && F.effectifs.length > 0;

    if (hasDepotEff) {
      for (const e of F.effectifs) {
        const name = canonical(norm(e.classe)); if (!name) continue;
        const row = byC.get(name) || { classe:name, filles:0, garcons:0 };
        row.filles  += Number(e.filles  || 0);
        row.garcons += Number(e.garcons || 0);
        byC.set(name, row);
      }
    } else {
      for (const c of (F.classes || [])) {
        const name = canonical(norm(c.nom)); if (!name) continue;
        const row = byC.get(name) || { classe:name, filles:0, garcons:0 };
        row.filles  += pick(c,'filles','Filles','f','F');
        row.garcons += pick(c,'garcons','Garcons','g','G');
        getDiscs(c).forEach(d => {
          row.filles  += pick(d,'filles','Filles','f','F');
          row.garcons += pick(d,'garcons','Garcons','g','G');
        });
        byC.set(name, row);
      }
    }
  }

  effectifs = Array.from(byC.values())
    .map(r => ({ classe:r.classe, filles:r.filles, garcons:r.garcons }))
    .sort((a,b)=> a.classe.localeCompare(b.classe));
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
// === Comptes staff (KPI Établissement)
const countsOne = await buildStaffCounts(req.insp, [etab], last?.annee);
const keyOne = normEtab(etab);
const scOne = countsOne.get(keyOne) || { total: 0, enPoste: 0 };

// si buildStaffCounts ne remonte rien, on prend la longueur de staff
const ensTotaux = scOne.total > 0 ? scOne.total : (Array.isArray(staff) ? staff.length : 0);

// RÈGLE demandée : en poste = total
const ensEnPoste = ensTotaux;

// IMPORTANT : si le front recompte depuis le statut, on l’uniformise
staff = (staff || []).map(p => ({ ...p, statut: 'en poste' }));

// --- Dédoublonnage du personnel ---
// priorité au matricule, sinon (nom+grade+matiere+statut)
staff = uniqBy(staff, s => {
  const m = (s.matricule || '').trim().toUpperCase();
  return m || [
    (s.nom||'').trim().toUpperCase(),
    (s.grade||'').trim().toUpperCase(),
    (s.matiere||'').trim().toUpperCase(),
    (s.statut||'').trim().toUpperCase()
  ].join('|');
});


 res.json({
  meta: { etablissement: etab, departement, annee: last?.annee || '', cycle: last?.cycle || '', specialite: last?.specialite || '' },
  ap,
  classesOuvertes: classes,
  effectifs,
  staff,
  enseignantsTotaux: ensTotaux,          // ← champs plats consommés par le front
  enseignantsEnPoste: ensEnPoste,        // ← égal au total
  depots: { received, missing, totalExpected: 6 }
});

  }catch(e){ next(e); }
});

// =========================================================
// GET /api/carte/region-staff?departement=&etablissement=&annee=&q=
// =========================================================
router.get('/region-staff', async (req, res, next) => {
  try {
    const { departement, etablissement, annee, q } = req.query;
    const deptMap = await buildDeptMap(req.insp);

    // périmètre établissements (depuis les collectes, cloisonné par inspection)
    let allEtabs = await Collecte.distinct('etablissement', { inspection: req.insp }).lean();
    if (etablissement) {
      allEtabs = allEtabs.filter(e => String(e) === String(etablissement));
    }

    // ------- Source 1: Teacher (si modèle présent) -------
    let tRows = [];
    if (Teacher) {
      try {
      const want = new Set(allEtabs.map(normEtab));
const list = await Teacher.find(annee ? { annee: String(annee) } : {}).lean();
const filtered = (list || []).filter(p => want.has(normEtab(p?.etablissement || '')));

tRows = filtered.map(p => ({
  etablissement : p.etablissement || '',
  departement   : deptMap.get(p.etablissement || '') || '—',
  nom           : p.nomComplet || p.nom || '',
  matricule     : p.matricule || p.matr || '',
  grade         : p.grade || '',
  categorie     : p.categorie || p.cat || '',
  dateNaissance : p.dateNaissance || p.naissance || '',
  sexe          : p.sexe || p.sex || '',
  regionOrigine : p.regionOrigine || p.region || '',
  departementOrigine  : p.departementOrigine || p.deptOrigine || '',
  arrondissementOrigine: p.arrondissementOrigine || p.arrOrigine || '',
  dateEntreeFP  : p.dateEntreeFP || p.dateEntree || '',
  posteOccupe   : p.posteOccupe || p.poste || '',
  dateAffectation: p.dateAffectation || p.nomination || '',
  rangPoste     : p.rangPoste || p.rang || '',
  telephone     : p.telephone || p.tel || '',
  matiere       : p.matiere || p.discipline || '',
  statut        : p.statut || '',
  classes       : Array.isArray(p.classes) ? p.classes.join(' / ') : (p.classes || ''),
  disciplines   : Array.isArray(p.disciplines) ? p.disciplines.join(' / ') : (p.disciplines || ''),
  obs           : p.obs || p.observations || ''
}));

      } catch (_) {}
    }

    // ------- Source 2: Settings.staff (fallback par établissement sans Teacher) -------
    const tEtabs = new Set(tRows.map(r => r.etablissement));
    const sRows = await Settings.find({
      inspection: req.insp,
      etablissement: { $in: allEtabs.filter(e => !tEtabs.has(e)) }
    }).select('etablissement staff').lean();

    const sMapped = [];
    for (const s of (sRows || [])) {
      const etab = s.etablissement || '';
      for (const p of (s.staff || [])) {
        sMapped.push({
          etablissement : etab,
          departement   : deptMap.get(etab) || '—',
          nom           : p.nom || '',
          matricule     : p.matricule || '',
          grade         : p.grade || '',
          categorie     : p.categorie || '',
          dateNaissance : p.dateNaissance || '',
          sexe          : p.sexe || '',
          regionOrigine : p.regionOrigine || '',
          departementOrigine  : p.departementOrigine || '',
          arrondissementOrigine: p.arrondissementOrigine || '',
          dateEntreeFP  : p.dateEntreeFP || '',
          posteOccupe   : p.posteOccupe || '',
          dateAffectation: p.dateAffectation || '',
          rangPoste     : p.rangPoste || '',
          telephone     : p.telephone || '',
          // annexes
          matiere       : p.matiere || '',
          statut        : p.statut || '',
          classes       : Array.isArray(p.classes) ? p.classes.join(' / ') : (p.classes || ''),
          disciplines   : Array.isArray(p.disciplines) ? p.disciplines.join(' / ') : (p.disciplines || ''),
          obs           : p.obs || ''
        });
      }
    }

    let out = [...tRows, ...sMapped];

    // filtres serveurs
    if (departement) {
      out = out.filter(r => String(r.departement) === String(departement));
    }
    if (etablissement) {
      out = out.filter(r => String(r.etablissement) === String(etablissement));
    }
    if (q && q.trim()) {
      const needle = q.trim().toLowerCase();
      out = out.filter(r => {
        const hay = [
          r.nom, r.matricule, r.grade, r.categorie, r.sexe,
          r.regionOrigine, r.departementOrigine, r.arrondissementOrigine,
          r.posteOccupe, r.telephone, r.matiere, r.statut
        ].join(' ').toLowerCase();
        return hay.includes(needle);
      });
    }

    res.json({ rows: out.sort((a, b) =>
      String(a.etablissement).localeCompare(String(b.etablissement), 'fr') ||
      String(a.nom).localeCompare(String(b.nom), 'fr')
    )});
  } catch (e) { next(e); }
});



module.exports = router;
