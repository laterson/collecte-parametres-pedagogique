// server/routes/inspecteur.js
const express = require('express');
const crypto  = require('crypto');

const SchoolCard = require('../../models/SchoolCard');
const Collecte   = require('../../models/Collecte');
const Upload     = require('../../models/Upload');

// Message peut être optionnel dans ton projet
let Message = null;
try { Message = require('../../models/Message'); } catch (_) { /* optionnel */ }

const router = express.Router();

/* ================== Helpers généraux ================== */
function fp(obj){
  const clone = JSON.parse(JSON.stringify(obj||{}));
  if (clone?.meta) delete clone.meta.generatedAt;
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

const normalize = v => String(v||'').trim();
const lower     = v => normalize(v).toLowerCase();

/* Rôles autorisés à utiliser ces endpoints API */
const ALLOWED = new Set(['anim','ap','insp','admin']);
function roleOk(req){
  const r = lower(req.user?.role);
  const alias = { animateur:'anim', ipr:'insp', inspector:'insp' };
  return ALLOWED.has(alias[r] || r);
}

/* Construit un filtre Mongo cloisonné par inspection + filtres optionnels */
function scopedFilter(req, base = {}) {
  const insp = lower(req.query.inspection || req.user?.inspection || '');
  const f = { ...base };
  if (insp) f.inspection = insp;

  // Ciblage fin (tous optionnels)
  const annee        = normalize(req.query.annee);
  const cycle        = normalize(req.query.cycle);
  const specialite   = normalize(req.query.specialite).toUpperCase();
  const etablissement= normalize(req.query.etablissement);
  const departement  = normalize(req.query.departement);

  if (annee)        f.annee        = annee;
  if (cycle)        f.cycle        = cycle;
  if (specialite)   f.specialite   = specialite;
  if (etablissement)f.etablissement= etablissement;
  if (departement)  f.departement  = departement;

  return f;
}

/* ===== Helpers côté serveur (alignés sur le front) ===== */
function isEnPosteServer(p){
  if (typeof p?.enPoste === 'boolean') return p.enPoste;
  const s = String(p?.statut || p?.status || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .trim().toLowerCase();
  const positif = /(titulaire|en poste|actif|present|affecte)/.test(s);
  const negatif = /(vacataire|absent|retire|sorti)/.test(s);
  return positif && !negatif;
}

function sumEffectifs(effectifs=[]){
  let F=0,G=0,T=0;
  for(const e of effectifs){
    const f = Number(e?.filles || e?.F || 0);
    const g = Number(e?.garcons || e?.G || 0);
    const t = Number(e?.total);
    F += f; G += g;
    T += Number.isFinite(t) && t>0 ? t : (f+g);
  }
  return { filles:F, garcons:G, total:T };
}

/* ================== Endpoints ================== */

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


/* ================== Endpoints alignés avec le front AP/IPR ================== */

/**
 * GET /carte/inspection
 * Agrégat par établissement pour la carte (attendu par le front).
 * Filtres: ?annee=&cycle=&specialite=&etablissement=&departement=
 */
router.get('/carte/inspection', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

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
        if(nom) acc.classes.add(String(nom));
      }

      // effectifs
      const eff = Array.isArray(r?.effectifs) ? r.effectifs
               : Array.isArray(r?.data?.effectifs) ? r.data.effectifs : [];
      const { filles, garcons, total } = sumEffectifs(eff);
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

    const rows = [...byEtab.values()].map(r=>{
      const apSet = apPerEtab.get(r.etablissement) || new Set();
      return {
        etablissement: r.etablissement,
        cycles: [...r.cycles],
        classes: [...r.classes],
        filles: r.filles,
        garcons: r.garcons,
        eleves:  r.eleves,
        enseignantsTotaux:  r.enseignantsTotaux,
        enseignantsEnPoste: r.enseignantsEnPoste,
        ap: [...apSet] // array, le front fait .length
      };
    }).sort((a,b)=> String(a.etablissement||'').localeCompare(b.etablissement||''));

    const stats = {
      etablissements: rows.length,
      apActifs: apGlobal.size, // unique AP dans l’inspection
      eleves: { total: rows.reduce((s,r)=> s + Number(r.eleves||0), 0) },
      enseignants: { enPoste: rows.reduce((s,r)=> s + Number(r.enseignantsEnPoste||0), 0) }
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
router.get('/summary/deposits', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });

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

    const rows = await Collecte.find(q).sort({ createdAt:-1 }).lean();
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

    res.json({ rows: out });
  }catch(e){ next(e); }
});


/**
 * GET /summary/deposits/:id
 * Détail d’un dépôt (pour l’overlay).
 */
router.get('/summary/deposits/:id', async (req, res, next) => {
  try{
    if (!roleOk(req)) return res.status(403).json({ error: 'forbidden' });
    const id = req.params.id;
    const d = await Collecte.findById(id).lean();
    if(!d) return res.status(404).json({ error:'not found' });

    res.json({
      id: String(d._id),
      etablissement: d.etablissement || '',
      animateur: d.animateur || '',
      cycle: d.cycle || '',
      specialite: d.specialite || '',
      evaluation: d.evaluation || null,
      annee: d.annee || '',
      createdAt: d.createdAt,
      classes: Array.isArray(d.classes) ? d.classes : [],
      files:   Array.isArray(d.files)   ? d.files   : [],
      meta: d.meta || {}
    });
  }catch(e){ next(e); }
});

module.exports = router;
