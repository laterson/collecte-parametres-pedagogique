const express = require('express');
const crypto  = require('crypto');
const Excel = require('exceljs');
const SchoolCard = require('../../models/SchoolCard');
const Collecte   = require('../../models/Collecte');
const Upload     = require('../../models/Upload');
const Settings = require('../../models/Settings');

let Message = null;
try { Message = require('../../models/Message'); } catch (_) { /* optionnel */ }

const router = express.Router();

// ================== Helpers Généraux ==================
const getYear = () => { const d=new Date(), y=d.getFullYear(), m=d.getMonth(); return (m>=7)? `${y}-${y+1}` : `${y-1}-${y}`; };
const normalize = v => String(v||'').trim();
const lower = v => normalize(v).toLowerCase();

// [R0] — normalisation forte d'établissement (accents, espaces, casse)
const normEtab = s => String(s||'')
  .normalize('NFD').replace(/\p{Diacritic}/gu,'') // retire les accents
  .replace(/\u00A0/g,' ').replace(/\s+/g,' ')     // espaces propres
  .trim().toLowerCase();

// Remplace l'ancienne version par celle-ci (fusion divisions ++ robuste)
const splitClassLabel = (label) => {
  // normalise espaces/diacritiques
  const raw0 = String(label || '')
    .replace(/\u00A0/g, ' ')                 // NBSP -> espace
    .replace(/\s+/g, ' ')                    // compresse espaces
    .trim();

  // on capture des suffixes de division très variés:
  // " (2)", "- 2", "/2", "#2", "div2", "section 2", "G2" en fin
  const m = raw0.match(
    /\s*(?:\(|#|\/|-|\bdiv(?:ision)?\b|\bsection\b|[GgSs])\s*(\d+)\s*\)?\s*$/u
  );
  if (!m) return { base: raw0, division: 1 };

  // base = tout ce qui précède le suffixe
  const base = raw0.slice(0, m.index).trim();
  const division = Number(m[1] || '1') || 1;

  return { base, division };
};

// Compte les enseignants par inspection + périmètre (annee, cycle, specialite, etablissement)
async function countTeachersForScope({ insp, annee, cycle, specialite, etablissement }) {
  const counts = { total: 0, enPoste: 0 };

  // périmètre d'établissements basé sur les Collecte (cloisonné par inspection)
  const qC = { inspection: insp };
  if (annee)      qC.annee = String(annee);
  if (cycle)      qC.cycle = String(cycle);
  if (specialite) qC.specialite = String(specialite).toUpperCase();
  if (etablissement) qC.etablissement = String(etablissement);

  const etabs = await Collecte.distinct('etablissement', qC).lean();

  // 1) Teacher (si modèle présent)
  try {
    const Teacher = require('../../models/Teacher');
    const qT = { etablissement: { $in: etabs } };
    if (annee) qT.annee = String(annee);
    const tRows = await Teacher.find(qT).lean();

    for (const p of (tRows || [])) {
      const statut = String(p.statut || '').toLowerCase();
      const isPoste = ['enseignant','en poste','titulaire','contractuel','actif','affecte','affecté']
        .some(k => statut.includes(k));
      counts.total += 1;
      if (isPoste) counts.enPoste += 1;
    }
  } catch (_) {}

  // 2) Fallback Settings.staff pour les étabs non couverts par Teacher
  const tEtabs = new Set(); // étabs déjà couverts par Teacher
  try {
    const Teacher = require('../../models/Teacher');
    const qT = { etablissement: { $in: etabs } };
    if (annee) qT.annee = String(annee);
    const tRows = await Teacher.find(qT).select('etablissement').lean();
    for (const r of (tRows || [])) tEtabs.add(r.etablissement);
  } catch (_) {}

  const missing = etabs.filter(e => !tEtabs.has(e));
  if (missing.length) {
    const sRows = await Settings.find({ inspection: insp, etablissement: { $in: missing } })
      .select('staff').lean();
    for (const s of (sRows || [])) {
      for (const p of (s.staff || [])) {
        const statut = String(p.statut || '').toLowerCase();
        const isPoste = ['enseignant','en poste','titulaire','contractuel','actif','affecte','affecté']
          .some(k => statut.includes(k));
        counts.total += 1;
        if (isPoste) counts.enPoste += 1;
      }
    }
  }

  return counts;
}



function fp(obj){ const clone = JSON.parse(JSON.stringify(obj||{})); if (clone?.meta) delete clone.meta.generatedAt; return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex'); }
const ALLOWED = new Set(['anim','ap','insp','admin']);
function roleOk(req){ const r = lower(req.user?.role); const alias = { animateur:'anim', ipr:'insp', inspector:'insp' }; return ALLOWED.has(alias[r] || r); }
function scopedFilter(req, base = {}) { const insp = lower(req.query.inspection || req.user?.inspection || ''); const f = { ...base }; if (insp) f.inspection = insp; const annee=normalize(req.query.annee), cycle=normalize(req.query.cycle), specialite=normalize(req.query.specialite).toUpperCase(), etablissement=normalize(req.query.etablissement), departement=normalize(req.query.departement); if (annee) f.annee = annee; if (cycle) f.cycle = cycle; if (specialite) f.specialite = specialite; if (etablissement) f.etablissement= etablissement; if (departement) f.departement = departement; return f; }
function isEnPosteServer(p){ if (typeof p?.enPoste === 'boolean') return p.enPoste; const s = String(p?.statut || p?.status || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').trim().toLowerCase(); const positif = /(titulaire|en poste|actif|present|affecte)/.test(s); const negatif = /(vacataire|absent|retire|sorti)/.test(s); return positif && !negatif; }
function sumEffectifs(effectifs=[]){ let F=0,G=0,T=0; for(const e of effectifs){ const f = Number(e?.filles||0), g = Number(e?.garcons||0), t = Number(e?.total); F += f; G += g; T += Number.isFinite(t) && t>0 ? t : (f+g); } return { filles:F, garcons:G, total:T }; }

// [K1] — Récupère la dernière carte par (etab, annee, cycle, specialite)
async function fetchLatestCardsForKPIs({ insp, annee, cycle, specialite }) {
  const q = {};
  if (insp)       { q.$or = [ { inspection: insp }, { 'meta.inspection': insp } ]; }
  if (annee)      { (q.$and ||= []).push({ $or: [ { annee }, { 'meta.annee': annee } ] }); }
  if (cycle)      { (q.$and ||= []).push({ $or: [ { cycle }, { 'meta.cycle': cycle } ] }); }
  if (specialite) { const sp = String(specialite).toUpperCase();
                    (q.$and ||= []).push({ $or: [ { specialite: sp }, { 'meta.specialite': sp } ] }); }

  // on trie décroissant → le premier vu pour une clé est la "dernière"
  const rows = await SchoolCard.find(q).sort({ receivedAt: -1 }).lean();

  const keyOf = (r)=>[
    String(r?.meta?.etablissement || r?.etablissement || '').trim().toLowerCase(),
    String(r?.meta?.annee || r?.annee || '').trim(),
    String(r?.meta?.cycle || r?.cycle || '').trim(),
    String(r?.meta?.specialite || r?.specialite || '').trim().toUpperCase()
  ].join('::');

  const latest = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!latest.has(k)) latest.set(k, r);
  }
  return [...latest.values()];
}

// [K1-bis] — Compte enseignants (total & en poste) depuis une liste de cartes
function countStaffFromCards(cards) {
  let tot = 0, enPoste = 0;
  for (const r of cards) {
    const staff = Array.isArray(r?.staff) ? r.staff
               : Array.isArray(r?.data?.staff) ? r.data.staff : [];
    tot     += staff.length;
    enPoste += staff.filter(isEnPosteServer).length;
  }
  return { tot, enPoste };
}



// ================== Utils synthèse (communs) ==================
const ACC_KEYS = ['Hd','Hf','Lp','Lf','Ldp','Ldf','Tp','Tf','Tdp','Tdf','Comp','M10','EffT','EffP'];
const zeroAcc  = () => ({ Hd:0,Hf:0,Lp:0,Lf:0,Ldp:0,Ldf:0,Tp:0,Tf:0,Tdp:0,Tdf:0,Comp:0,M10:0,EffT:0,EffP:0 });
const addTo    = (acc, src) => { for (const k of ACC_KEYS) acc[k] += Number(src?.[k]||0); };
const pct      = (d, n) => (Number(d)>0 ? (Number(n)/Number(d))*100 : 0);

function mapDiscipline(d){
  // Harmonise les différents noms de champs reçus des AP
  const n = (o, ...keys)=>{ for(const k of keys){ const v=o?.[k]; if(v!=null && String(v).trim?.()!=='') return Number(v)||0; } return 0; };
  return {
    nom : d.discipline || d.nom || d.name || '',
    Hd  : n(d,'hD','Hd','heuresDues'),
    Hf  : n(d,'hF','Hf','heuresFaites'),
    Lp  : n(d,'lp','Lp','leconsPrevues'),
    Lf  : n(d,'lf','Lf','leconsFaites'),
    Ldp : n(d,'ldp','Ldp','leconsDigPrevues','leconsDigitaliseesPrevues'),
    Ldf : n(d,'ldf','Ldf','leconsDigFaites','leconsDigitaliseesFaites'),
    Tp  : n(d,'tp','Tp','tpPrevus'),
    Tf  : n(d,'tf','Tf','tpFaits'),
    Tdp : n(d,'tdp','Tdp','tpDigPrevus','tpDigitalisesPrevus'),
    Tdf : n(d,'tdf','Tdf','tpDigFaits','tpDigitalisesFaits'),
    Comp: n(d,'comp','Comp','elevesComposes','eleves'),
    M10 : n(d,'m10','M10'),
    EffT: n(d,'effTot','EffT','ensTot','enseignantsTotaux'),
    EffP: n(d,'effPos','EffP','ensPoste','enseignantsEnPoste')
  };
}


// ======= Synthèse unifiée (2 modes) =======
router.get('/synthese', async (req, res, next) => {
  try {
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

    const u = req.session.user;
    const annee = req.query.annee || getYear();
    const { cycle, specialite, evaluation, classe, mode='by-etab' } = req.query;

    const filter = { inspection: u.inspection, annee };
    if (cycle) filter.cycle = cycle;
    if (specialite) filter.specialite = specialite;
    if (evaluation) filter.evaluation = Number(evaluation);

    const collectes = await Collecte.find(filter).lean();

    // Helpers
    const pct = (d, n) => (Number(d) > 0 ? (Number(n) / Number(d)) * 100 : 0);
    const accKeys = ['hD','hF','lp','lf','ldp','ldf','tp','tf','tdp','tdf','comp','m10'];
    const addTotals = (to, d) => accKeys.forEach(k=> to[k] += Number(d?.[k]||0));

    if (mode === 'by-class-base') {
      // —— Mode 1 : par classe de base
      const syntheseParClasse = new Map();
      const etablissements = new Set();
      const apActifs = new Set();
      let totalEleves = 0;
      let totalEnseignantsEnPoste = 0;

      for (const collecte of collectes){
        etablissements.add(collecte.etablissement);
        apActifs.add(collecte.animateur);

        (collecte.classes || []).forEach(division=>{
          const { base } = splitClassLabel(division.nom);
          if (!syntheseParClasse.has(base)){
            syntheseParClasse.set(base, {
              etablissements: new Set(),
              hD:0,hF:0,lp:0,lf:0,ldp:0,ldf:0,tp:0,tf:0,tdp:0,tdf:0,comp:0,m10:0,
              effectif:0
            });
          }
          const C = syntheseParClasse.get(base);
          C.etablissements.add(collecte.etablissement);

          (division.disciplines || []).forEach(d=> addTotals(C, d));
          const effDiv = (division.effectifs||[]).reduce((s,e)=> s + (Number(e.filles||0)+Number(e.garcons||0)), 0);
          C.effectif = Math.max(C.effectif, effDiv);
        });

        (collecte.effectifs||[]).forEach(eff=> totalEleves += (Number(eff.filles||0)+Number(eff.garcons||0)));
        (collecte.staff||[]).forEach(st=> { if (isEnPosteServer(st)) totalEnseignantsEnPoste++; });
      }

      const rows = [...syntheseParClasse.entries()].map(([classe, C])=>({
        classe,
        etablissements: [...C.etablissements],
        effectif: C.effectif,
        hD:C.hD,hF:C.hF, lp:C.lp,lf:C.lf, ldp:C.ldp,ldf:C.ldf, tp:C.tp,tf:C.tf, tdp:C.tdp,tdf:C.tdf, comp:C.comp,m10:C.m10
      })).sort((a,b)=> a.classe.localeCompare(b.classe));

      const G = rows.reduce((g,r)=>{ accKeys.forEach(k=> g[k]+=Number(r[k]||0)); return g; },
        {hD:0,hF:0,lp:0,lf:0,ldp:0,ldf:0,tp:0,tf:0,tdp:0,tdf:0,comp:0,m10:0});

      const kpis = {
        etablissements: new Set(rows.flatMap(r=>r.etablissements)).size,
        apActifs: new Set(collectes.map(c=>c.animateur).filter(Boolean)).size,
        depots: collectes.length,
        eleves: totalEleves,
        enseignantsEnPoste: totalEnseignantsEnPoste,
        couvertureHeures: pct(G.hD, G.hF),
        leconsFaites: pct(G.lp, G.lf),
        leconsDigitaliseesFaites: pct(G.ldp, G.ldf),
        tpFaits: pct(G.tp, G.tf),
        tpDigitalisesFaits: pct(G.tdp, G.tdf),
        reussite: pct(G.comp, G.m10)
      };

      return res.json({ mode, kpis, synthese: rows });
    }

    // —— Mode 2 (défaut) : par établissement (option classe=)
    const syntheseParEtab = new Map();
    const apSet = new Set();
    const etabSet = new Set();
    const uniqueEffectifs = new Map();
    const uniqueStaff =  new Map();

    for (const collecte of collectes){
      etabSet.add(collecte.etablissement);
      if (collecte.animateur) apSet.add(collecte.animateur);

      if (!syntheseParEtab.has(collecte.etablissement)){
        syntheseParEtab.set(collecte.etablissement, new Map());
      }
      const classesMap = syntheseParEtab.get(collecte.etablissement);

      (collecte.effectifs||[]).forEach(eff=>{
        const key = `${collecte.etablissement}-${eff.classe}`;
        uniqueEffectifs.set(key, eff);
      });

      (collecte.staff||[]).forEach(st=>{
        const key = `${collecte.etablissement}-${st.nom}`;
        if (!uniqueStaff.has(key)) uniqueStaff.set(key, st);
      });

      (collecte.classes||[]).forEach(division=>{
        const { base } = splitClassLabel(division.nom);
        if (classe && base !== classe) return;
        if (!classesMap.has(base)){
          classesMap.set(base, { hD:0,hF:0,lp:0,lf:0,ldp:0,ldf:0,tp:0,tf:0,tdp:0,tdf:0,comp:0,m10:0 });
        }
        const C = classesMap.get(base);
        (division.disciplines||[]).forEach(d=> addTotals(C, d));
      });
    }

    const totalEleves = [...uniqueEffectifs.values()]
      .reduce((s,eff)=> s + (Number(eff.filles||0)+Number(eff.garcons||0)), 0);
    const totalEnseignants = [...uniqueStaff.values()].filter(isEnPosteServer).length;

    const syntheseFinale = [];
    for (const [etablissement, classesMap] of syntheseParEtab.entries()){
      if (classesMap.size === 0) continue;
      const classesArray = [...classesMap.entries()]
        .map(([classeBase, total])=>({ classe: classeBase, total }))
        .sort((a,b)=> a.classe.localeCompare(b.classe));
      syntheseFinale.push({ etablissement, classes: classesArray });
    }
    syntheseFinale.sort((a,b)=> a.etablissement.localeCompare(b.etablissement));

    const G = syntheseFinale.reduce((g, etab)=>{
      etab.classes.forEach(c=> accKeys.forEach(k=> g[k]+=Number(c.total[k]||0)));
      return g;
    }, {hD:0,hF:0,lp:0,lf:0,ldp:0,ldf:0,tp:0,tf:0,tdp:0,tdf:0,comp:0,m10:0});

    const kpis = {
      etablissements: etabSet.size,
      apActifs: apSet.size,
      depots: collectes.length,
      eleves: totalEleves,
      enseignantsEnPoste: totalEnseignants,
      couvertureHeures: pct(G.hD, G.hF),
      leconsFaites: pct(G.lp, G.lf),
      leconsDigitaliseesFaites: pct(G.ldp, G.ldf),
      tpFaits: pct(G.tp, G.tf),
      tpDigitalisesFaits: pct(G.tdp, G.tdf),
      reussite: pct(G.comp, G.m10)
    };

    res.json({ mode:'by-etab', kpis, synthese: syntheseFinale });
  } catch (e) {
    console.error('Erreur GET /inspecteur/synthese:', e);
    next(e);
  }
});


/**
 * POST /carte-scolaire
 * Réception d'une carte scolaire émise par un AP (ou saisie côté insp).
 * (si ce router est monté sous /api, l’URL finale sera /api/carte-scolaire)
 */
router.post('/carte-scolaire', async (req, res, next) => {
  try {
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

    const body = req.body||{};
    const m = body.meta||{};

    if (!m.annee || !m.cycle || !m.specialite || !m.etablissement || !m.inspection) {
      return res.status(400).json({
        error:'Paramètres manquants (meta.annee, meta.cycle, meta.specialite, meta.etablissement, meta.inspection)'
      });
    }

    // Cloison inspection en plus du guard global
    const inspUser = lower(req.user?.inspection||'');
    if (inspUser && lower(m.inspection) !== inspUser) {
      return res.status(403).json({ error:'forbidden: mauvaise inspection' });
    }

    const key = {
      'meta.inspection'   : m.inspection,
      'meta.etablissement': m.etablissement,
      'meta.annee'        : m.annee,
      'meta.cycle'        : m.cycle,
      'meta.specialite'   : m.specialite
    };

    const last  = await SchoolCard.findOne(key).sort({ receivedAt:-1 }).lean();
    const newFp = fp(body);
    let version = 1, isUpdate = false, prevFingerprint = null;

    if (last) {
      if (last.fingerprint !== newFp) {
        version = (last.version||1) + 1;
        isUpdate = true;
        prevFingerprint = last.fingerprint||null;
      } else {
        return res.json({ ok:true, message:'Carte identique déjà enregistrée (aucun changement).' });
      }
    }

    const doc = await SchoolCard.create({
      ...body,
      version,
      fingerprint: newFp,
      prevFingerprint,
      receivedAt: new Date(),
      updatedAt: new Date()
    });

    // notifier socket
    req.app.get('io')?.emit('carte:updated', {
      key: {
        inspection   : m.inspection,
        etablissement: m.etablissement,
        annee        : m.annee,
        cycle        : m.cycle,
        specialite   : m.specialite
      },
      at      : new Date().toISOString(),
      isUpdate,
      version : doc.version
    });

    res.json({
      ok:true,
      message: isUpdate ? 'Carte scolaire mise à jour.' : 'Carte scolaire enregistrée.',
      version: doc.version
    });
  } catch (e) { next(e); }
});

/**
 * GET /carte-scolaire/latest
 * Retourne la dernière version par (etablissement, annee, cycle, specialite)
 * Filtres: ?annee=&cycle=&specialite=&etablissement=
 */
router.get('/carte-scolaire/latest', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

    const f = scopedFilter(req, {});
    const mongo = {};
    if (f.inspection)   mongo['meta.inspection']   = f.inspection;
    if (f.annee)        mongo['meta.annee']        = f.annee;
    if (f.cycle)        mongo['meta.cycle']        = f.cycle;
    if (f.specialite)   mongo['meta.specialite']   = f.specialite;
    if (f.etablissement)mongo['meta.etablissement']= f.etablissement;

    const rows = await SchoolCard.find(mongo).sort({ receivedAt:-1 }).lean();

    const key = (m)=> [
      lower(m?.etablissement||''),
      normalize(m?.annee||''),
      normalize(m?.cycle||''),
      normalize(m?.specialite||'').toUpperCase()
    ].join('::');

    const latest = new Map();
    for (const r of rows) {
      const k = key(r?.meta||{});
      if (!latest.has(k)) latest.set(k, r);
    }

    res.json({ rows: Array.from(latest.values()) });
  }catch(e){ next(e); }
});

/**
 * GET /dashboard
 * Petit résumé pour le tableau de bord insp (dans l’inspection)
 * Filtres: ?annee=&cycle=&specialite=&etablissement=&departement=
 */
router.get('/dashboard', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

    // Collectes (dépôts) – résumé
    const fCollecte = scopedFilter(req, {});
    const depots = await Collecte.find(fCollecte).sort({ createdAt:-1 }).lean();

    const apSet       = new Set();
    const etabSet     = new Set();
    const byEval      = {1:0,2:0,3:0,4:0,5:0,6:0};
    const lastDeposits= depots.slice(0, 10).map(d=>({
      id: String(d._id),
      etablissement: d.etablissement,
      animateur: d.animateur,
      cycle: d.cycle,
      specialite: d.specialite,
      evaluation: d.evaluation,
      annee: d.annee,
      createdAt: d.createdAt,
      classes: (d.classes||[]).length
    }));

    for (const d of depots){
      if (d.animateur) apSet.add(d.animateur);
      if (d.etablissement) etabSet.add(d.etablissement);
      if (byEval[d.evaluation]!=null) byEval[d.evaluation]++;
    }

    // Fichiers partagés récents (inspection)
    const fUpload = scopedFilter(req, {});
    const uploadQuery = { inspection: fUpload.inspection };
    if (fUpload.etablissement) uploadQuery.etablissement = fUpload.etablissement;
    if (fUpload.departement)   uploadQuery.departement   = fUpload.departement;

    const lastFiles = await Upload.find(uploadQuery).sort({ createdAt:-1 }).limit(10).lean();
    const files = lastFiles.map(f => ({
      id: String(f._id),
      name: f.name,
      size: f.size,
      createdAt: f.createdAt,
      path: f.path,
      url: '/' + String(f.path||'').replace(/\\/g,'/'),
      ownerName: f.ownerName || '',
      ownerRole: f.ownerRole || '',
      etablissement: f.etablissement || ''
    }));

    // Messages récents (optionnel)
    let messages = [];
    if (Message) {
      const fMsg = scopedFilter(req, {});
      const msgQuery = { inspection: fMsg.inspection };
      if (fMsg.etablissement) msgQuery.etablissement = fMsg.etablissement;

      const lastMsgs = await Message.find(msgQuery).sort({ createdAt:-1 }).limit(10).lean().catch(()=>[]);
      messages = (lastMsgs||[]).map(m => ({
        id: String(m._id),
        auteur: m.auteur || m.from || '',
        etablissement: m.etablissement || '',
        texte: m.texte || m.message || '',
        createdAt: m.createdAt
      }));
    }

    res.json({
      stats: {
        etablissements: etabSet.size,
        apActifs: apSet.size,
        depots: depots.length,
        parEvaluation: byEval
      },
      lastDeposits,
      files,
      messages
    });
  }catch(e){ next(e); }
});


// === SUPPRESSION BULK de cartes scolaires par liste d'IDs (dernières versions cochées dans l'UI)
router.delete('/carte-scolaire', async (req, res, next) => {
  try {
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error:'ids requis' });

    // Cloisonnement: uniquement les cartes de l’inspection de l’utilisateur
    const inspUser = String((req.user?.inspection || '')).toLowerCase();

    const docs = await SchoolCard.find({ _id: { $in: ids } }).select('_id meta').lean();
    const allowed = docs
      .filter(d => String(d?.meta?.inspection || '').toLowerCase() === inspUser)
      .map(d => d._id);

    if (!allowed.length) return res.json({ ok: true, deleted: 0 });

    const r = await SchoolCard.deleteMany({ _id: { $in: allowed } });

    // Notifier le front (facultatif)
    try {
      for (const d of docs) {
        if (allowed.includes(d._id)) {
          req.app.get('io')?.emit('carte:deleted', {
            id: String(d._id),
            key: {
              inspection   : d.meta?.inspection || '',
              etablissement: d.meta?.etablissement || '',
              annee        : d.meta?.annee || '',
              cycle        : d.meta?.cycle || '',
              specialite   : d.meta?.specialite || ''
            },
            at: new Date().toISOString()
          });
        }
      }
    } catch (_) {}

    res.json({ ok: true, deleted: r.deletedCount || 0 });
  } catch (e) { next(e); }
});

/**
 * GET /summary/topology
 * Arbre explorateur: cycles -> spécialités -> classes (divisions fusionnées)
 */
/**
 * GET /summary/topology
 * Arbre explorateur: cycles -> spécialités -> classes (divisions fusionnées)
 */
/**
 * GET /summary/topology
 * cycles -> spécialités -> classes (divisions fusionnées)
 */
router.get('/summary/topology', async (req,res,next)=>{
  try{
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });

    const u = req.session.user;
    const annee = req.query.annee || getYear();
    const f = { inspection: u.inspection, annee };

    const rows = await Collecte.find(f).select('cycle specialite classes').lean();

    const normalizeSpace = s => String(s||'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();
    const keyify = s => normalizeSpace(s).toLowerCase();

    // cycleKey -> { label, specialites: Map(specKey -> { label, classes:Set }) }
    const byCycle = new Map();

    for (const r of rows){
      const cycLabel = normalizeSpace(r.cycle) || '—';
      const specLabel = (normalizeSpace(r.specialite) || '—').toUpperCase();

      const cycKey  = keyify(cycLabel);
      const specKey = keyify(specLabel);

      if (!byCycle.has(cycKey))
        byCycle.set(cycKey, { label: cycLabel, specialites: new Map() });

      const C = byCycle.get(cycKey);

      if (!C.specialites.has(specKey))
        C.specialites.set(specKey, { label: specLabel, classes: new Set() });

      const S = C.specialites.get(specKey);

      (r.classes || []).forEach(div => {
        const raw = div?.nom || div?.classe || div || '';
        const { base } = splitClassLabel(raw);     // <-- fusion divisions
        if (base) S.classes.add(normalizeSpace(base));
      });
    }

    // sérialisation triée
    const cycles = [...byCycle.entries()]
      .map(([cycKey, C]) => ({
        key: C.label,
        label: C.label,
        specialites: [...C.specialites.entries()]
          .map(([specKey, S]) => ({
            key: S.label,            // libellé de la spécialité pour l’affichage
            classes: [...S.classes].sort((a,b)=>a.localeCompare(b,'fr'))
          }))
          .sort((a,b)=>a.key.localeCompare(b.key,'fr'))
      }))
      .sort((a,b)=>a.key.localeCompare(b.key,'fr'));

    res.json({ cycles });
  }catch(e){ next(e); }
});


/**
 * GET /summary/kpis
 * KPIs centraux (heures, leçons, TP, réussite, effectifs, #étab, #AP, #dépôts)
 * Query: ?cycle=&specialite= (facultatifs)
 */
router.get('/summary/kpis', async (req,res,next)=>{
  try{
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });
    const u = req.session.user;
    const annee = req.query.annee || getYear();
    const { cycle, specialite } = req.query;
    const classeBase = normalize(req.query.classe);

    const f = { inspection: u.inspection, annee };
    if (cycle)      f.cycle = cycle;
    if (specialite) f.specialite = String(specialite).toUpperCase();

    const rows = await Collecte.find(f).lean();

    const etabSet = new Set();
    const apSet   = new Set();
    const totals  = zeroAcc();
    let eleves = 0, ensEnPoste = 0;

    for (const d of rows){
      if (d.etablissement) etabSet.add(d.etablissement);
      if (d.animateur)     apSet.add(d.animateur);

      (d.classes||[]).forEach(div=>{
     // si classe demandée, on ne garde que la base correspondante
       if (classeBase){
         const { base } = splitClassLabel(div?.nom||div?.classe||'');
         if (base !== classeBase) return;
       }
       (div.disciplines||div.modules||[])
         .map(mapDiscipline)
         .forEach(x=> addTo(totals, x));
    });

      (d.effectifs||[]).forEach(e=>{
       if (classeBase){
         const { base } = splitClassLabel(e?.classe||'');
         if (base !== classeBase) return;
       }
        const f = Number(e?.filles||0), g = Number(e?.garcons||0);
        const t = Number(e?.total);
        eleves += Number.isFinite(t)&&t>0 ? t : (f+g);
      });

    }
// Borne "réussite" pour éviter toute sur-comptabilisation croisée
const compCap = Math.max(0, totals.Comp);
const m10Cap  = Math.max(0, Math.min(totals.M10, compCap));
    const taux = {
      couvertureHeures   : pct(totals.Hd,  totals.Hf),
      leconsFaites       : pct(totals.Lp,  totals.Lf),
      leconsDigitalFaites: pct(totals.Ldp, totals.Ldf),
      tpFaits            : pct(totals.Tp,  totals.Tf),
      tpDigitalFaits     : pct(totals.Tdp, totals.Tdf),
      reussite           : pct(compCap, m10Cap)
    };

// [K2] — Compter les enseignants depuis Teacher (+fallback Settings)
 const staffKPIs = await countTeachersForScope({
   insp : String(u.inspection || '').toLowerCase(),
   annee,
   cycle,
   specialite
 });
 // compat: la tuile front lit "enseignantsEnPoste" → on lui donne un nombre non nul
 ensEnPoste = staffKPIs.enPoste || staffKPIs.total;
 const enseignantsTotauxRegion = staffKPIs.total;


    res.json({
      etablissements: etabSet.size,
      apActifs: apSet.size,
      depots: rows.length,
      effectifsRegion: {
  eleves,
  enseignantsEnPoste: ensEnPoste,   // inchangé pour compat UI
  enseignantsTotaux: enseignantsTotauxRegion // nouveau champ si tu veux l'afficher
},
      taux
    });
  }catch(e){ next(e); }
});

/**
 * GET /summary/form-view
 * Blocs “classe -> disciplines + total” (utilisé par la table centrale)
 * Query: ?cycle=...&specialite=...&classe=(optionnel)
 */
 // ===== util: normalisation espace/accents (en haut si pas déjà présent)
const normSpaces = s => String(s||'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim();
const normKey    = s => normSpaces(s).normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();

// ===== remplace la lecture de la liste par ce helper
function getDiscList(div){
  // 1) tableaux classiques sous divers alias
  const candidates = [
    div?.disciplines,
    div?.modules,
    div?.matieres,      // variantes FR
    div?.matières,
    div?.subjects,      // EN
    div?.programmes,
    div?.programme,
  ].filter(Array.isArray);

  if (candidates.length && candidates[0].length) return candidates[0];

  // 2) forme "objet" : { "Technologie": {...}, "TP": {...} }
  const obj =
    (div && typeof div.disciplines === 'object' && !Array.isArray(div.disciplines) && div.disciplines) ||
    (div && typeof div.modules     === 'object' && !Array.isArray(div.modules)     && div.modules)     ||
    (div && typeof div.matieres    === 'object' && !Array.isArray(div.matieres)    && div.matieres)    ||
    (div && typeof div.subjects    === 'object' && !Array.isArray(div.subjects)    && div.subjects)    ||
    (div && typeof div.programme   === 'object' && !Array.isArray(div.programme)   && div.programme);

  if (obj){
    return Object.entries(obj).map(([name, payload]) => ({
      nom: name, ...(payload||{})
    }));
  }

  // 3) rien trouvé
  return [];
}

// ===== élargis mapDiscipline (alias supplémentaires FR/EN)
function mapDiscipline(d){
  const num = (o, ...keys)=>{ 
    for(const k of keys){ 
      const v = o?.[k]; 
      if (v!=null && String(v).trim?.()!=='') return Number(v)||0; 
    } 
    return 0; 
  };
  return {
    nom : d.discipline || d.nom || d.name || d.module || d.matiere || d.subject || '',
    // heures
    Hd  : num(d,'hD','Hd','heuresDues','heuresPrevues','hoursDue','hoursPlanned'),
    Hf  : num(d,'hF','Hf','heuresFaites','hoursDone','hoursMade'),
    // leçons
    Lp  : num(d,'lp','Lp','leconsPrevues','lessonsPrevues','lessonsPlanned','nbLeconsPrevues'),
    Lf  : num(d,'lf','Lf','leconsFaites','lessonsFaites','lessonsDone','nbLeconsFaites'),
    // leçons digitalisées
    Ldp : num(d,'ldp','Ldp','leconsDigPrevues','leconsDigitaliseesPrevues','lessonsDigitalPlanned'),
    Ldf : num(d,'ldf','Ldf','leconsDigFaites','leconsDigitaliseesFaites','lessonsDigitalDone'),
    // TP
    Tp  : num(d,'tp','Tp','tpPrevus','travauxPrevus','practicalsPlanned'),
    Tf  : num(d,'tf','Tf','tpFaits','travauxFaits','practicalsDone'),
    // TP digitalisés
    Tdp : num(d,'tdp','Tdp','tpDigPrevus','tpDigitalisesPrevus','practicalsDigitalPlanned'),
    Tdf : num(d,'tdf','Tdf','tpDigFaits','tpDigitalisesFaits','practicalsDigitalDone'),
    // réussite & effectifs (si jamais présents dans les modules)
    Comp: num(d,'comp','Comp','elevesComposes','eleves','studentsSatForExam'),
    M10 : num(d,'m10','M10','studentsPassed','reussis'),
    EffT: num(d,'effTot','EffT','ensTot','enseignantsTotaux','teachersTotal'),
    EffP: num(d,'effPos','EffP','ensPoste','enseignantsEnPoste','teachersOnPost')
  };
}

router.get('/summary/form-view', async (req,res,next)=>{
  try{
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });
    const u = req.session.user;
    const annee = req.query.annee || getYear();
    const { cycle, specialite } = req.query;
    const classeFilterRaw = normalize(req.query.classe);           // affichage
    const classeFilterKey = classeFilterRaw ? normKey(classeFilterRaw) : ''; // comparaison

    if (!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

    const f = { inspection: u.inspection, annee, cycle, specialite: String(specialite).toUpperCase() };
    const rows = await Collecte.find(f).lean();

    // Agrégat: base -> { etablissements:Set, labelBase:String, disciplines:Map(key->{label,acc}), total:acc }
    const byClass = new Map();

    for (const d of rows){
      const etab = d.etablissement || '';
      for (const div of (d.classes||[])){
        const raw = div?.nom || div?.classe || '';
        if (!raw) continue;

        const { base } = splitClassLabelRobust(raw);     // base robuste
        const baseKey  = normKey(base);
        if (!baseKey) continue;
        if (classeFilterKey && baseKey !== classeFilterKey) continue;

        if (!byClass.has(baseKey)) byClass.set(baseKey, {
          etablissements: new Set(),
          labelBase: base,                // on retient l’étiquette telle qu’elle apparaît
          disciplines: new Map(),         // key canonique -> { label, acc }
          total: zeroAcc()
        });
        const C = byClass.get(baseKey);
        if (etab) C.etablissements.add(etab);

       const list = getDiscList(div).map(mapDiscipline);

        for (const disc of list){
          const rawName = disc.nom || '';
          const key     = normKey(rawName);
          if (!key) continue;            // skip sans nom

          if (!C.disciplines.has(key)){
            // on garde le premier libellé “propre” qu’on voit pour l’affichage
            C.disciplines.set(key, { label: normSpaces(rawName), acc: zeroAcc() });
          }
          const slot = C.disciplines.get(key);
          addTo(slot.acc, disc);
          addTo(C.total, disc);
        }
      }
    }

    const out = [...byClass.values()]
      .map(C => ({
        classe: C.labelBase,                         // étiquette lisible
        etablissements: C.etablissements.size,
        disciplines: [...C.disciplines.values()]
          .map(({label, acc}) => ({ nom: label, ...acc }))
          .sort((a,b)=> String(a.nom||'').localeCompare(String(b.nom||''),'fr')),
        total: C.total
      }))
      .sort((a,b)=> String(a.classe||'').localeCompare(String(b.classe||''),'fr'));

    res.json(out.length===1 ? out[0] : out);
  }catch(e){ next(e); }
});


/* ================== Endpoints alignés avec le front AP/IPR ================== */

/**
 * GET /carte/inspection
 * Agrégat par établissement pour la carte (attendu par le front).
 * Filtres: ?annee=&cycle=&specialite=&etablissement=&departement=
 */
router.get('/carte/inspection', async (req, res, next) => {
  try{

    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });
const classeBase = normalize(req.query.classe);
    // récupérer toutes les cartes filtrées
    const f = scopedFilter(req, {});
    const mongo = {};
    if (f.inspection)   mongo['meta.inspection']    = f.inspection;
    if (f.annee)        mongo['meta.annee']         = f.annee;
    if (f.cycle)        mongo['meta.cycle']         = f.cycle;
    if (f.specialite)   mongo['meta.specialite']    = f.specialite;
    if (f.etablissement)mongo['meta.etablissement'] = f.etablissement;
    if (f.departement)  mongo['meta.departement']   = f.departement;

    const cards = await SchoolCard.find(mongo).sort({ receivedAt:-1 }).lean();

    // garder la dernière version par (etab, annee, cycle, spec)
    const key = (r)=>[
      lower(r?.meta?.etablissement||r?.etablissement||''),
      normalize(r?.meta?.annee||r?.annee||''),
      normalize(r?.meta?.cycle||r?.cycle||''),
      normalize(r?.meta?.specialite||r?.specialite||'').toUpperCase()
    ].join('::');

    const latest = new Map();
    for(const r of cards){
      const k = key(r);
      if(!latest.has(k)) latest.set(k, r);
    }

    // agrégat par établissement
    const byEtab = new Map();
    for(const r of latest.values()){
      const etab = r?.meta?.etablissement || '';
      if (!byEtab.has(etab)){
        byEtab.set(etab, {
          etablissement: etab,
          cycles: new Set(),
          classes: new Set(),
          filles: 0, garcons: 0, eleves: 0,
          enseignantsTotaux: 0,
          enseignantsEnPoste: 0
        });
      }
      const acc = byEtab.get(etab);

      // cycles
      if (r?.meta?.cycle) acc.cycles.add(String(r.meta.cycle));

      // classes ouvertes
     const classes = Array.isArray(r?.classes) ? r.classes
                    : Array.isArray(r?.data?.classes) ? r.data.classes : [];
      for(const c of classes){
        const nom = c?.nom || c?.classe || c;
        if(!nom) continue;
       const base = splitClassLabel(nom).base;
       if (classeBase && base !== classeBase) continue;
       acc.classes.add(String(base));
      }

      // effectifs
      const eff = Array.isArray(r?.effectifs) ? r.effectifs
               : Array.isArray(r?.data?.effectifs) ? r.data.effectifs : [];
     const effFiltered = classeBase ? eff.filter(e=> splitClassLabel(e?.classe||'').base === classeBase) : eff;
     const { filles, garcons, total } = sumEffectifs(effFiltered);
      acc.filles  += filles;
      acc.garcons += garcons;
      acc.eleves  += (Number(r?.eleves) || total || 0);

      // staff
      const staff = Array.isArray(r?.staff) ? r.staff
                  : Array.isArray(r?.data?.staff) ? r.data.staff : [];
      acc.enseignantsTotaux   += staff.length;
      acc.enseignantsEnPoste  += staff.filter(isEnPosteServer).length;
    }

    // AP actifs (via Collecte)
    const fC = scopedFilter(req, {});
    const qC = {};
    if (fC.inspection)    qC.inspection    = fC.inspection;
    if (fC.etablissement) qC.etablissement = fC.etablissement;
    if (fC.cycle)         qC.cycle         = fC.cycle;
    if (fC.specialite)    qC.specialite    = fC.specialite;

    const depots = await Collecte.find(qC).select('etablissement animateur').lean();
    const apPerEtab = new Map();
    const apGlobal  = new Set();
    for(const d of depots){
      const e = d?.etablissement||'';
      if(!apPerEtab.has(e)) apPerEtab.set(e, new Set());
      if(d?.animateur){
        apPerEtab.get(e).add(String(d.animateur));
        apGlobal.add(String(d.animateur));
      }
    }

    const rows = [...byEtab.values()].map(r => {
  // on retient l'ID d'une "dernière carte" pour cet établissement
  // (dans le périmètre filtré, c’est suffisant pour permettre une suppression depuis l’UI)
  let lastCardId = null;
  for (const L of latest.values()) {
    if ((L?.meta?.etablissement || '') === r.etablissement) {
      lastCardId = String(L._id);
      break;
    }
  }

  const apSet = apPerEtab.get(r.etablissement) || new Set();
  return {
    etablissement: r.etablissement,
    cycles: [...r.cycles],
    classes: [...r.classes],
    filles: r.filles,
    garcons: r.garcons,
    eleves: r.eleves,
    enseignantsTotaux: r.enseignantsTotaux,
    enseignantsEnPoste: r.enseignantsEnPoste,
    ap: [...apSet],
    lastCardId // <<< NOUVEAU
  };
}).sort((a,b)=> String(a.etablissement||'').localeCompare(b.etablissement||''));

   const sumTot   = rows.reduce((s,r)=> s + Number(r.enseignantsTotaux||0), 0);
 const sumPoste = rows.reduce((s,r)=> s + Number(r.enseignantsEnPoste||0), 0);
 const stats = {
   etablissements: rows.length,
   apActifs: apGlobal.size,
   eleves: { total: rows.reduce((s,r)=> s + Number(r.eleves||0), 0) },
   enseignants: { enPoste: sumPoste > 0 ? sumPoste : sumTot }
 };

    res.json({ rows, stats });
  }catch(e){ next(e); }
});

/**
 * GET /carte/etab?etablissement=...
 * Détails consolidés pour l’overlay (effectifs + staff + meta).
 */
router.get('/carte/etab', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

    const etab = normalize(req.query.etablissement);
    if(!etab) return res.status(400).json({ error:'etablissement requis' });

    const f = scopedFilter(req, { etablissement: etab });
    const mongo = {};
    if (f.inspection)   mongo['meta.inspection']    = f.inspection;
    mongo['meta.etablissement'] = etab;
    if (f.annee)        mongo['meta.annee']         = f.annee;
    if (f.cycle)        mongo['meta.cycle']         = f.cycle;
    if (f.specialite)   mongo['meta.specialite']    = f.specialite;

    const cards = await SchoolCard.find(mongo).sort({ receivedAt:-1 }).lean();

    const effectifs = [];
    const staff     = [];
    let meta = { etablissement: etab };

    for(const r of cards){
      meta = { ...(r.meta||{}), etablissement: etab, annee: r?.meta?.annee||meta.annee };
      const eff = Array.isArray(r?.effectifs) ? r.effectifs
               : Array.isArray(r?.data?.effectifs) ? r.data.effectifs : [];
      effectifs.push(...eff);

      const st  = Array.isArray(r?.staff) ? r.staff
               : Array.isArray(r?.data?.staff) ? r.data.staff : [];
      staff.push(...st);
    }

    res.json({ meta, effectifs, staff });
  }catch(e){ next(e); }
});

/**
 * GET /summary/deposits
 * Liste filtrée des dépôts (mailbox droite).
 * Période : ?evaluation=1..6  OU  ?trimestre=T1|T2|T3 (T1=1+2, T2=3+4, T3=5+6)
 */
// 🔁 BLOC A — /summary/deposits (avec pagination)
router.get('/summary/deposits', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });
const classeBase = normalize(req.query.classe);
    const f = scopedFilter(req, {});
    const q = {};
    if (f.inspection)    q.inspection    = f.inspection;
    if (f.annee)         q.annee         = f.annee;
    if (f.cycle)         q.cycle         = f.cycle;
    if (f.specialite)    q.specialite    = f.specialite;
    if (f.etablissement) q.etablissement = f.etablissement;
    if (f.departement)   q.departement   = f.departement;

    const ev  = normalize(req.query.evaluation);
    const tri = normalize(req.query.trimestre).toUpperCase();
    if (ev) q.evaluation = Number(ev);
    else if (tri){
      const map = { T1:[1,2], T2:[3,4], T3:[5,6] }[tri] || [];
      if (map.length) q.evaluation = { $in: map };
    }

    // —— pagination
    const page  = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '20', 10)));
    const skip  = (page - 1) * limit;

   const all = await Collecte.find(q).sort({ createdAt:-1 }).lean();
   const filtered = classeBase
     ? all.filter(d => (d.classes||[]).some(div => splitClassLabel(div?.nom||div?.classe||'').base === classeBase))
     : all;
   const total   = filtered.length;
   const rows    = filtered.slice(skip, skip+limit);

    const out = rows.map(d=>({
      id: String(d._id),
      etablissement: d.etablissement || '',
      animateur: d.animateur || '',
      cycle: d.cycle || '',
      specialite: d.specialite || '',
      evaluation: d.evaluation || null,
      annee: d.annee || '',
      createdAt: d.createdAt,
      classes: Array.isArray(d.classes) ? d.classes.length : 0
    }));

    res.json({ rows: out, page, limit, total });
  }catch(e){ next(e); }
});

/**
 * GET /summary/deposits/:id
 * Détail d’un dépôt (pour l’overlay).
 */
// 🔁 BLOC B — /summary/deposits/:id (fichiers harmonisés)
// /summary/deposits/:id — détail d’un dépôt (overlay)
router.get('/summary/deposits/:id', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });
    const id = req.params.id;
    const d = await Collecte.findById(id).lean();
    if (!d) return res.status(404).json({ error:'not found' });

    // Unifier les fichiers (pieces/fichiers/uploads) -> {name, path}
    const files = []
      .concat(d.pieces || [])
      .concat(d.fichiers || [])
      .concat(d.uploads || [])
      .filter(Boolean)
      .map(f => {
        if (typeof f === 'string') {
          return { name: f.split('/').pop(), path: f };
        }
        const name = f.name || f.filename || (f.path ? String(f.path).split('/').pop() : '') || 'fichier';
        const path = f.path || f.url || '';
        return { name, path };
      });

    // On renvoie les champs attendus par le front (openDeposit / classTable / fileRow)
    res.json({
      id: String(d._id),
      etablissement: d.etablissement || '',
      animateur: d.animateur || '',
      cycle: d.cycle || '',
      specialite: d.specialite || '',
      evaluation: d.evaluation ?? null,
      annee: d.annee || '',
      createdAt: d.createdAt,
      // classes telles que déposées (le front sait lire disciplines/modules et calcule les totaux)
      classes: Array.isArray(d.classes) ? d.classes : [],
      // fichiers unifiés
      files
    });
  }catch(e){
    next(e);
  }
});

// —— Répartition élèves + (si dispo) enseignants H/F par cycle
router.get('/gender-by-cycle', async (req, res, next)=>{
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });
    const u = req.session.user;
    const annee = req.query.annee || getYear();
    const f = { inspection: u.inspection, annee };

    const rows = await Collecte.find(f).lean();

    const out = {
      premier: { filles:0, garcons:0, ensH:0, ensF:0, ensPoste:0 },
      second : { filles:0, garcons:0, ensH:0, ensF:0, ensPoste:0 },
      total  : { filles:0, garcons:0, ensH:0, ensF:0, ensPoste:0 },
      hasTeacherSex:false
    };
    const pick = (o, ...keys)=> keys.reduce((s,k)=> s + (Number(o?.[k]||0)||0), 0);
    const n = (o, ...keys)=> { for(const k of keys){ const v=o?.[k]; if(v!=null && String(v).trim()!=='') return Number(v)||0 } return 0 };

    for (const F of rows){
      const bucket = (String(F.cycle)==='premier') ? out.premier : out.second;
      (F.classes||[]).forEach(c=>{
        bucket.filles  += pick(c,'filles','Filles','F','f');
        bucket.garcons += pick(c,'garcons','Garcons','G','g');
        (Array.isArray(c.disciplines)?c.disciplines:(Array.isArray(c.modules)?c.modules:[])).forEach(d=>{
          bucket.filles  += pick(d,'filles','Filles','F','f');
          bucket.garcons += pick(d,'garcons','Garcons','G','g');
          bucket.ensPoste += n(d,'effPos','EffP','ensPoste');

          const h = n(d,'ensH','enseignantsHommes','ensHommes');
          const f = n(d,'ensF','enseignantsFemmes','ensFemmes');
          if (h||f){ out.hasTeacherSex=true; bucket.ensH += h; bucket.ensF += f; }
        });
      });
    }
    ['filles','garcons','ensH','ensF','ensPoste'].forEach(k=>{
      out.total[k] = (out.premier[k]||0) + (out.second[k]||0);
    });
    res.json(out);
  }catch(e){ next(e); }
});

// === SUPPRIMER la dernière carte scolaire d'un établissement (dans le périmètre courant)
router.delete('/carte-scolaire/last', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });

    const etab = String(req.query.etablissement || '').trim();
    if (!etab) return res.status(400).json({ error:'etablissement requis' });

    // périmètre : inspection obligatoire + filtres fournis (annee, cycle, specialite)
    const f = scopedFilter(req, { etablissement: etab });
    const mongo = {};
    if (f.inspection)   mongo['meta.inspection']    = f.inspection;
    mongo['meta.etablissement'] = etab;
    if (f.annee)        mongo['meta.annee']         = f.annee;
    if (f.cycle)        mongo['meta.cycle']         = f.cycle;
    if (f.specialite)   mongo['meta.specialite']    = f.specialite;

    // on prend la + récente (receivedAt desc)
    const last = await SchoolCard.findOne(mongo).sort({ receivedAt:-1 });
    if (!last) return res.status(404).json({ error:'not found' });

    await SchoolCard.deleteOne({ _id: last._id });

    // notify front
    req.app.get('io')?.emit('carte:deleted', {
      id: String(last._id),
      key: {
        inspection   : last.meta?.inspection || '',
        etablissement: last.meta?.etablissement || '',
        annee        : last.meta?.annee || '',
        cycle        : last.meta?.cycle || '',
        specialite   : last.meta?.specialite || ''
      },
      at: new Date().toISOString()
    });

    res.json({ ok:true, message:'Dernière carte supprimée' });
  }catch(e){ next(e); }
});

// === SUPPRESSION d'une carte scolaire (par _id)
router.delete('/carte-scolaire/:id', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });
    const id = req.params.id;
    const doc = await SchoolCard.findById(id);
    if (!doc) return res.status(404).json({ error:'not found' });

    // cloisonnement inspection
    const inspUser = String((req.user?.inspection||'')).toLowerCase();
    const inspDoc  = String((doc.meta?.inspection||'')).toLowerCase();
    if (inspUser && inspUser !== inspDoc) return res.status(403).json({ error:'forbidden' });

    await SchoolCard.deleteOne({ _id:id });

    // notifie le front
    req.app.get('io')?.emit('carte:deleted', {
      id,
      key: {
        inspection   : doc.meta?.inspection || '',
        etablissement: doc.meta?.etablissement || '',
        annee        : doc.meta?.annee || '',
        cycle        : doc.meta?.cycle || '',
        specialite   : doc.meta?.specialite || ''
      },
      at: new Date().toISOString()
    });

    res.json({ ok:true });
  }catch(e){ next(e); }
});


// === SUPPRESSION d'un dépôt (Collecte) par _id
router.delete('/deposits/:id', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error:'forbidden' });
    const id = req.params.id;
    const d = await Collecte.findById(id);
    if (!d) return res.status(404).json({ error:'not found' });

    const inspUser = String((req.user?.inspection||'')).toLowerCase();
    const inspDoc  = String((d.inspection||'')).toLowerCase();
    if (inspUser && inspUser !== inspDoc) return res.status(403).json({ error:'forbidden' });

    await Collecte.deleteOne({ _id:id });

    req.app.get('io')?.emit('deposit:deleted', {
      id,
      meta: {
        inspection: d.inspection||'',
        etablissement: d.etablissement||'',
        cycle: d.cycle||'',
        specialite: d.specialite||'',
        evaluation: d.evaluation||null
      },
      at: new Date().toISOString()
    });

    res.json({ ok:true });
  }catch(e){ next(e); }
});

// ================== EXPORT EXCEL — fichier du personnel ==================
// ================== EXPORT EXCEL — fichier du personnel (recompose depuis Teacher + Settings) ==================

// Date tolérante: accepte Date, "YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY"
function toFrDate(v){
  if (!v) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    let d;
    // 2025-09-01
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // 01/09/2025 ou 01-09-2025
    if (!d) {
      m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m) d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    }
    // fallback: parse natif
    if (!d) d = new Date(s);
    if (Number.isNaN(d)) return '';
    const p = n => String(n).padStart(2,'0');
    return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
  }
  const d = new Date(v); if (Number.isNaN(d)) return '';
  const p = n => String(n).padStart(2,'0');
  return `${p(d.getDate())}/${p(d.getMonth()+1)}/${d.getFullYear()}`;
}

const get = (o, ...keys) => {
  for (const k of keys) {
    const v = o?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
};

// [R1] — buildDeptMap : etab -> département, filtré par inspection + année
async function buildDeptMap(insp, annee){
  const map = new Map();
  if (!SchoolCard) return map;

  // on accepte schema meta.* et flat
  const q = { $or: [ { inspection: insp }, { 'meta.inspection': insp } ] };
  if (annee) {
    q.$and = [ { $or: [ { annee }, { 'meta.annee': annee } ] } ];
  }

  const rows = await SchoolCard.find(q)
    .select('etablissement departement meta annee')
    .lean()
    .catch(()=>[]);

  for (const r of rows){
    const etabRaw = r.etablissement || r?.meta?.etablissement || '';
    const dept    = r.departement  || r?.meta?.departement  || '—';
    const k = normEtab(etabRaw);              // ⚠️ clé normalisée
    if (k) map.set(k, dept);
  }
  return map;
}

// etab -> departement (depuis SchoolCard.meta si dispo)
// [REPERE A] — buildDeptMap filtré par inspection + année
async function buildDeptMap(insp, annee){
  const map = new Map();
  if (!SchoolCard) return map;

  const q = { $or: [ { inspection: insp }, { 'meta.inspection': insp } ] };
  if (annee) {
    // on ne retient QUE les cartes de l'année demandée
    q.$and = [ { $or: [ { annee }, { 'meta.annee': annee } ] } ];
  }

  const rows = await SchoolCard.find(q)
    .select('etablissement departement meta annee')
    .lean()
    .catch(()=>[]);

  for (const r of rows){
    const etab = r.etablissement || r?.meta?.etablissement || '';
    const dept = r.departement  || r?.meta?.departement  || '—';
    if (etab) map.set(etab, dept);
  }
  return map;
}

// ⬇️ remplace ton handler actuel par celui-ci
router.get('/enseignants/export.xlsx', async (req, res) => {
  try {
    if (!roleOk(req)) return res.status(403).json({ ok:false, error:'forbidden' });

    const insp  = String(req.user?.inspection || '').toLowerCase();
    const annee = String(req.query.annee || '');
    const qDept = normalize(req.query.departement || '');
    const qEtab = normalize(req.query.etablissement || req.query.etab || '');
    const qText = (req.query.q || '').toString().toLowerCase().trim();

    // [REPERE B] — carte des établissements « valides » pour l’année
const deptMap = await buildDeptMap(insp, annee);

    // 2) charger le personnel depuis Teacher puis compléter avec Settings.staff
    const allRows = [];

    // 2a) Teacher (si modèle dispo)
    try {
      const Teacher = require('../../models/Teacher');
      const tFilter = {};
      if (annee) tFilter.annee = annee;
      if (qEtab) tFilter.etablissement = qEtab;
      const tRows = await Teacher.find(tFilter).lean();

      for (const p of (tRows||[])) {
        const etab = normalize(get(p,'etablissement','ecole','etab'));
        if (!deptMap.has(etab)) continue;  
        const dept = deptMap.get(etab) || '—';
        if (qDept && dept !== qDept) continue;

        const hay = [
          get(p,'nomComplet','nom','name','noms'),
          get(p,'matricule','mat'),
          get(p,'grade'),
          get(p,'categorie','category','cat'),
          get(p,'posteOccupe','poste'),
          get(p,'telephone','tel','phone')
        ].join(' ').toLowerCase();
        if (qText && !hay.includes(qText)) continue;

        allRows.push({
          etablissement: etab,
          departement: dept,
          nom         : get(p,'nomComplet','nom','name','noms'),
          matricule   : get(p,'matricule','mat'),
          grade       : get(p,'grade'),
          categorie   : get(p,'categorie','category','cat'),
          dateNaissance: get(p,'dateNaissance','naissance','dNaissance','date_naissance'),
          sexe        : get(p,'sexe','genre'),
          regionOrigine       : get(p,'regionOrigine','region','region_origine'),
          departementOrigine  : get(p,'departementOrigine','departement','departement_origine'),
          arrondissementOrigine: get(p,'arrondissementOrigine','arrondissement','arrondissement_origine'),
          dateEntreeFP        : get(p,'dateEntreeFP','dateEntreeFonctionPublique','entreeFP','date_entree_fp'),
          posteOccupe         : get(p,'posteOccupe','poste'),
          dateAffectation     : get(p,'dateAffectation','dateNomination','date_affectation'),
          rangPoste           : get(p,'rangPoste','rang'),
          telephone           : get(p,'telephone','tel','phone')
        });
      }
    } catch (_) {}

    // 2b) Fallback Settings.staff (pour les établissements non couverts par Teacher)
    const sFilter = { inspection: insp };
    if (qEtab) sFilter.etablissement = qEtab;
    const sRows = await Settings.find(sFilter).select('etablissement staff').lean().catch(()=>[]);
    for (const s of (sRows||[])) {
      const etab = normalize(s.etablissement);
      if (!deptMap.has(etab)) continue; 
      const dept = deptMap.get(etab) || '—';
      if (qDept && dept !== qDept) continue;

      for (const p of (s.staff||[])) {
        const hay = [
          get(p,'nom','name','noms'),
          get(p,'matricule','mat'),
          get(p,'grade'),
          get(p,'categorie','category','cat'),
          get(p,'posteOccupe','poste'),
          get(p,'telephone','tel','phone')
        ].join(' ').toLowerCase();
        if (qText && !hay.includes(qText)) continue;

        allRows.push({
          etablissement: etab,
          departement: dept,
          nom         : get(p,'nom','name','noms'),
          matricule   : get(p,'matricule','mat'),
          grade       : get(p,'grade'),
          categorie   : get(p,'categorie','category','cat'),
          dateNaissance: get(p,'dateNaissance','naissance','dNaissance','date_naissance'),
          sexe        : get(p,'sexe','genre'),
          regionOrigine       : get(p,'regionOrigine','region','region_origine'),
          departementOrigine  : get(p,'departementOrigine','departement','departement_origine'),
          arrondissementOrigine: get(p,'arrondissementOrigine','arrondissement','arrondissement_origine'),
          dateEntreeFP        : get(p,'dateEntreeFP','dateEntreeFonctionPublique','entreeFP','date_entree_fp'),
          posteOccupe         : get(p,'posteOccupe','poste'),
          dateAffectation     : get(p,'dateAffectation','dateNomination','date_affectation'),
          rangPoste           : get(p,'rangPoste','rang'),
          telephone           : get(p,'telephone','tel','phone')
        });
      }
    }

    // 3) tri par nom (comme sur la page)
    allRows.sort((a,b)=> String(a.nom||'').localeCompare(String(b.nom||''), 'fr'));

    // 4) groupage par établissement → 1 onglet/établissement
    const byEtab = new Map();
    for (const r of allRows) {
      if (!byEtab.has(r.etablissement)) byEtab.set(r.etablissement, []);
      byEtab.get(r.etablissement).push(r);
    }

    // 5) Excel
    const wb = new Excel.Workbook();
    wb.creator = 'Collecte — Inspection';
    wb.created = new Date();
    const fileName = `Fichier_enseignants_${annee || 'export'}.xlsx`;

    // Styles communs
    const headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF9AA3AD' } };
    const headFont = { bold: true, color: { argb: 'FFFFFFFF' } };
    const center   = { vertical: 'middle', horizontal: 'center' };
    const thin     = { style:'thin', color:{argb:'FFD8DDE3'} };

    const headers = [
      'No','Noms et prénoms','Matricule','Grade','Catégorie',
      'Date de naissance','Sexe',"Région d'origine","Département d'origine",
      "Arrondissement d'origine","Date d'entrée à la fonction publique",
      'Poste occupé',"Date d’affectation ou de nomination",'Rang du poste','Contact téléphonique'
    ];

    for (const [etab, list] of byEtab.entries()) {
      const ws = wb.addWorksheet(etab.slice(0,31) || 'Etablissement', { views: [{ state:'frozen', ySplit: 5 }] });

      // Bandeau
      ws.mergeCells('A1:O1');
      ws.getCell('A1').value = `Fichier complet des enseignants — ${annee || ''}`;
      ws.getCell('A1').font  = { bold:true, size:14 };
      ws.getCell('A1').alignment = { horizontal:'left' };

      ws.mergeCells('A2:O2');
      ws.getCell('A2').value = `Établissement : ${etab}`;
      ws.getCell('A2').alignment = { horizontal:'left' };

      const dept = list[0]?.departement || '—';
      ws.mergeCells('A3:O3');
      ws.getCell('A3').value = `Département : ${dept}`;
      ws.getCell('A3').alignment = { horizontal:'left' };

      ws.addRow([]);

      // En-tête
      ws.addRow(headers);
      ws.getRow(5).height = 18;
      ws.getRow(5).eachCell(c => {
        c.fill = headFill;
        c.font = headFont;
        c.alignment = center;
        c.border = { top:thin, left:thin, bottom:thin, right:thin };
      });

      // Données — mêmes colonnes que la page
      list.forEach((r,i) => {
        const tel = String(get(r,'telephone') || '').replace(/\s+/g,' ').trim();
        ws.addRow([
          i+1,
          r.nom || '',
          r.matricule || '',
          r.grade || '',
          r.categorie || '',
          toFrDate(r.dateNaissance),
          r.sexe || '',
          r.regionOrigine || '',
          r.departementOrigine || '',
          r.arrondissementOrigine || '',
          toFrDate(r.dateEntreeFP),
          r.posteOccupe || '',
          toFrDate(r.dateAffectation),
          r.rangPoste || '',
          tel
        ]);
      });

      const widths = [5, 28, 14, 12, 12, 14, 6, 16, 18, 20, 20, 16, 18, 12, 18];
      widths.forEach((w, idx) => ws.getColumn(idx + 1).width = w);
      ws.columns.forEach((col, idx) => {
        col.alignment = (idx === 2 || idx === 15) ? { vertical:'middle', horizontal:'left' } : center;
      });
      for (let r = 5; r <= ws.lastRow.number; r++) {
        ws.getRow(r).eachCell(c => c.border = { top:thin, left:thin, bottom:thin, right:thin });
      }
    }

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Export Excel staff:', e);
    res.status(500).json({ ok:false, error:'Export Excel impossible.' });
  }
});




module.exports = router;

