// server/routes/summary.js
const express = require('express');
const router  = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const Collecte = require('../../models/Collecte');

/* ─────────── Middlewares ─────────── */
router.use(requireAuth);
const onlyInsp = requireRole(['insp','admin']);

/* ─────────── Helpers période ─────────── */
const TRI  = { T1:[1,2], T2:[3,4], T3:[5,6] };
function periodFilter(q){
  if(q.evaluation){ return { evaluation: Number(q.evaluation) }; }
  if(q.trimestre){
    const t = String(q.trimestre).toUpperCase();
    const set = TRI[t] || [];
    return set.length ? { evaluation:{ $in:set } } : {};
  }
  return {};
}
/* ─────────── Helpers agrégations ─────────── */
const pct  = (den,num)=> den ? Number(((num/den)*100).toFixed(1)) : 0;
const norm = s => String(s ?? '').trim();
function emptyTotals(){
  return { Hd:0,Hf:0, Lp:0,Lf:0, Ldp:0,Ldf:0, Tp:0,Tf:0, Tdp:0,Tdf:0, Comp:0,M10:0, EffT:0,EffP:0 };
}
const getDiscs = (c)=> Array.isArray(c?.disciplines) ? c.disciplines
                      : (Array.isArray(c?.modules) ? c.modules : []);
const n = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim?.()!=='') return Number(v) || 0;
  }
  return 0;
};
function addTotals(T, d){
  T.Hd  += n(d,'hD','Hd','heuresDues');
  T.Hf  += n(d,'hF','Hf','heuresFaites');
  T.Lp  += n(d,'lp','Lp','leconsPrevues');
  T.Lf  += n(d,'lf','Lf','leconsFaites');
  T.Ldp += n(d,'ldp','Ldp','leconsDigPrevues','leconsDigitaliseesPrevues');
  T.Ldf += n(d,'ldf','Ldf','leconsDigFaites','leconsDigitaliseesFaites');
  T.Tp  += n(d,'tp','Tp','tpPrevus');
  T.Tf  += n(d,'tf','Tf','tpFaits');
  T.Tdp += n(d,'tdp','Tdp','tpDigPrevus','tpDigitalisesPrevus');
  T.Tdf += n(d,'tdf','Tdf','tpDigFaits','tpDigitalisesFaits');
  T.Comp+= n(d,'comp','Comp','elevesComposes','eleves');
  T.M10 += n(d,'m10','M10');
  T.EffT+= n(d,'effTot','EffT','ensTot','enseignantsTotaux');
  T.EffP+= n(d,'effPos','EffP','ensPoste','enseignantsEnPoste');
}
function packTotals(T){
  const out = {
    Hd:T.Hd, Hf:T.Hf, Lp:T.Lp, Lf:T.Lf, Ldp:T.Ldp, Ldf:T.Ldf,
    Tp:T.Tp, Tf:T.Tf, Tdp:T.Tdp, Tdf:T.Tdf, Comp:T.Comp, M10:T.M10, EffT:T.EffT, EffP:T.EffP,
    H_pct : pct(T.Hd,T.Hf),
    L_pct : pct(T.Lp,T.Lf),
    Ld_pct: pct(T.Ldp,T.Ldf),
    Tp_pct: pct(T.Tp,T.Tf),
    Td_pct: pct(T.Tdp,T.Tdf),
    R_pct : pct(T.Comp,T.M10),
    A_pct : pct(T.EffT,T.EffP),
  };
  // alias pour ton front
  out.H = out.H_pct; out.Pc = out.L_pct; out.Pd = out.Ld_pct;
  out.Tc = out.Tp_pct; out.Td = out.Td_pct; out.R = out.R_pct; out.A = out.A_pct;
  return out;
}

/* ──────────────────────────────────────────────────────────────
   1) Topology (explorateur à gauche)
   ────────────────────────────────────────────────────────────── */
router.get('/topology', onlyInsp, async (req,res)=>{
  const { annee, evaluation, trimestre } = req.query;
  const f = { inspection: (req.user?.inspection||'').toLowerCase() };
  if (annee)      f.annee = String(annee);
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[String(trimestre).toUpperCase()]||[] };

  const fiches = await Collecte.find(f).select('cycle specialite classes.nom').lean();
  const byCycle = new Map();
  for (const F of fiches){
    const cycle = String(F.cycle);
    const spec  = String(F.specialite||'').toUpperCase();
    const classes = (F.classes||[]).map(c=> String(c.nom||'').trim()).filter(Boolean);
    if (!byCycle.has(cycle)) byCycle.set(cycle, new Map());
    const mapSpec = byCycle.get(cycle);
    if (!mapSpec.has(spec)) mapSpec.set(spec, new Set());
    const setClasses = mapSpec.get(spec);
    classes.forEach(c=> setClasses.add(c));
  }
  const cycles = Array.from(byCycle.entries()).map(([cycle, specs])=>({
    key:cycle, label: cycle==='premier' ? 'Premier' : 'Second',
    specialites: Array.from(specs.entries()).map(([spec,setC])=>({ key:spec, label:spec, classes: Array.from(setC).sort() }))
                   .sort((a,b)=> a.key.localeCompare(b.key))
  })).sort((a,b)=> a.key.localeCompare(b.key));

  res.json({ cycles });
});

/* ──────────────────────────────────────────────────────────────
   2) KPIs
   ────────────────────────────────────────────────────────────── */
router.get('/kpis', onlyInsp, async (req,res)=>{
  const { annee, cycle, specialite, classe } = req.query;

  const f = { inspection:(req.user?.inspection||'').toLowerCase() };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  Object.assign(f, periodFilter(req.query));

  const fiches = await Collecte.find(f).lean();
  const estab = new Set();
  const anims = new Set();
  let depots = 0;
  const T = emptyTotals();

  for (const F of fiches){
    depots += 1;
    estab.add(F.etablissement||'—');
    if (F.animateur) anims.add(F.animateur);
    (F.classes||[]).forEach(c=>{
      if (classe && norm(c.nom).toLowerCase() !== norm(classe).toLowerCase()) return;
      getDiscs(c).forEach(d=> addTotals(T,d));
    });
  }
  const P = packTotals(T);
  res.json({
    etablissements: estab.size,
    apActifs: anims.size,
    depots,
    effectifsRegion: { enseignantsTotaux: T.EffT, enseignantsEnPoste: T.EffP, eleves: T.Comp },
    taux: {
      couvertureHeures: P.H, leconsFaites: P.Pc, leconsDigitalFaites: P.Pd,
      tpFaits: P.Tc, tpDigitalFaits: P.Td, reussite: P.R
    }
  });
});

/* ──────────────────────────────────────────────────────────────
   3) form-view : agrégé par classe -> disciplines (+ total)
   ────────────────────────────────────────────────────────────── */
router.get('/form-view', onlyInsp, async (req,res)=>{
  const { cycle, specialite, classe } = req.query;
  if(!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

  const f = {
    inspection: (req.user?.inspection||'').toLowerCase(),
    cycle: String(cycle),
    specialite: String(specialite).toUpperCase(),
    ...periodFilter(req.query)
  };
  const fiches = await Collecte.find(f).lean();

  // collect classes présentes
  const discovered = new Set();
  for (const F of fiches) (F.classes||[]).forEach(c=>{
    const name = String(c.nom||'').trim();
    if (name) discovered.add(name);
  });
  let classNames = Array.from(discovered).sort((a,b)=> a.localeCompare(b));
  if (classe && !classNames.includes(classe)) classNames.push(classe);

  function buildFor(clName){
    const perDisc = {};
    const etabs   = new Set();
    const wanted  = norm(clName).toLowerCase();

    for (const F of fiches){
      const cl = (F.classes||[]).find(c => norm(c.nom).toLowerCase() === wanted);
      if(!cl) continue;
      etabs.add(F.etablissement||'—');
      getDiscs(cl).forEach(d=>{
        const key = norm(d.discipline ?? d.nom ?? d.name);
        const T = (perDisc[key] ||= emptyTotals());
        addTotals(T, d);
      });
    }

    const rows = Object.entries(perDisc)
      .map(([nom,T])=> ({ nom, ...packTotals(T) }))
      .sort((a,b)=> a.nom.localeCompare(b.nom));

    // total classe
    const total = Object.values(perDisc).reduce((acc,T)=>{ addTotals(acc,T); return acc; }, emptyTotals());

    return { classe: clName, etablissements: etabs.size, disciplines: rows, total: packTotals(total) };
  }

  if (classe) return res.json(buildFor(classe));
  res.json(classNames.map(buildFor));
});

/* ──────────────────────────────────────────────────────────────
   4) by-etab : lignes pour la carte scolaire (utilisé par fetchByEtab)
   ────────────────────────────────────────────────────────────── */
router.get('/by-etab', onlyInsp, async (req,res)=>{
  const { cycle, specialite } = req.query;
  if(!cycle || !specialite) return res.json([]);

  const f = {
    inspection: (req.user?.inspection||'').toLowerCase(),
    cycle: String(cycle),
    specialite: String(specialite).toUpperCase(),
    ...periodFilter(req.query)
  };
  const docs = await Collecte.find(f).lean();

  // On renvoie ce que ton front utilise: etablissement, Comp, EffP, animateurs, cycle, spec
  const perEtab = new Map();
  for (const doc of docs){
    const key  = doc.etablissement||'—';
    const slot = perEtab.get(key) || { etablissement:key, Comp:0, EffP:0, animateurs:new Set(), cycle:doc.cycle, spec:doc.specialite };
    if (doc.animateur) slot.animateurs.add(doc.animateur);
    (doc.classes||[]).forEach(c=>{
      getDiscs(c).forEach(d=>{
        slot.Comp += n(d,'comp','Comp','elevesComposes','eleves');
        slot.EffP += n(d,'effPos','EffP','ensPoste','enseignantsEnPoste');
      });
    });
    perEtab.set(key, slot);
  }

  const out = [...perEtab.values()].map(r=>({
    etablissement: r.etablissement,
    Comp: r.Comp,
    EffP: r.EffP,
    animateurs: r.animateurs.size || 0,
    cycle: r.cycle,
    spec: r.spec
  })).sort((a,b)=> a.etablissement.localeCompare(b.etablissement));

  res.json(out);
});

/* ──────────────────────────────────────────────────────────────
   5) risk : établissements sous un seuil pour une métrique
   ────────────────────────────────────────────────────────────── */
router.get('/risk', onlyInsp, async (req,res)=>{
  const { cycle, specialite, metric='L_pct', threshold='60' } = req.query;
  const thr = Number(threshold)||0;
  if(!cycle || !specialite) return res.json({ rows:[], metric, threshold:thr });

  const f = {
    inspection:(req.user?.inspection||'').toLowerCase(),
    cycle:String(cycle),
    specialite:String(specialite).toUpperCase(),
    ...periodFilter(req.query)
  };
  const fiches = await Collecte.find(f).lean();

  const byE = {};
  for (const F of fiches){
    const key = F.etablissement || '—';
    const T = (byE[key] ||= { etablissement:key, ...emptyTotals() });
    (F.classes||[]).forEach(c=> getDiscs(c).forEach(d=> addTotals(T,d)));
  }
  const rows = Object.values(byE).map(T=> ({ etablissement:T.etablissement, ...packTotals(T) }));
  const filtered = rows.filter(r => (r[metric]??100) <= thr).sort((a,b)=> (a[metric]??0) - (b[metric]??0));
  res.json({ metric, threshold:thr, rows:filtered });
});

/* ──────────────────────────────────────────────────────────────
   6) list : liste brute des dépôts (pour un cycle/spec)
   ────────────────────────────────────────────────────────────── */
router.get('/list', onlyInsp, async (req,res)=>{
  const { cycle, specialite } = req.query;
  if(!cycle || !specialite) return res.json([]);

  const f = {
    inspection:(req.user?.inspection||'').toLowerCase(),
    cycle:String(cycle),
    specialite:String(specialite).toUpperCase(),
    ...periodFilter(req.query)
  };
  const docs = await Collecte.find(f).sort({ dateDepot:-1 }).lean();

  const out = docs.map(doc=>{
    const T = emptyTotals();
    (doc.classes||[]).forEach(c=> getDiscs(c).forEach(d=> addTotals(T,d)));
    const P = packTotals(T);
    return {
      id:String(doc._id),
      etablissement:doc.etablissement, animateur:doc.animateur, evaluation:doc.evaluation,
      H:P.H, Pc:P.Pc, Pd:P.Pd, Tc:P.Tc, Td:P.Td, R:P.R, A:P.A
    };
  });

  res.json(out);
});

/* ──────────────────────────────────────────────────────────────
   7) Mailbox dépôts (pane de droite) + lecture d’un dépôt
   ────────────────────────────────────────────────────────────── */
router.get('/deposits', onlyInsp, async (req,res)=>{
  const { annee, cycle, specialite } = req.query;
  const f = { inspection:(req.user?.inspection||'').toLowerCase() };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  Object.assign(f, periodFilter(req.query));

  const docs = await Collecte.find(f).sort({ createdAt:-1 }).lean();
  const rows = docs.map(d=>({
    id: String(d._id), etablissement: d.etablissement, animateur: d.animateur,
    cycle: d.cycle, specialite: d.specialite, evaluation: d.evaluation,
    annee: d.annee, createdAt: d.createdAt, classes: (d.classes||[]).length
  }));
  res.json({ rows });
});

router.get('/deposits/:id', onlyInsp, async (req,res)=>{
  const { id } = req.params;
  const doc = await Collecte.findOne({ _id:id, inspection:(req.user?.inspection||'').toLowerCase() }).lean();
  if (!doc) return res.status(404).json({ error:'not found' });

  const files = []
    .concat(doc.pieces || [])
    .concat(doc.fichiers || [])
    .concat(doc.uploads || [])
    .filter(Boolean)
    .map(f => {
      if (typeof f === 'string') return { name: f.split('/').pop(), path: f };
      return { name: f.name || f.filename || f.path?.split('/').pop() || 'fichier', path: f.path || f.url || f };
    });

  res.json({
    id: String(doc._id),
    etablissement: doc.etablissement,
    animateur: doc.animateur,
    cycle: doc.cycle,
    specialite: doc.specialite,
    evaluation: doc.evaluation,
    annee: doc.annee,
    createdAt: doc.createdAt,
    classes: doc.classes || [],
    files
  });
});

module.exports = router;
