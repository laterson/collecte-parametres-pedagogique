// routes/settings.js
const express    = require('express');
const router     = express.Router();
const Settings   = require('../models/Settings');
const Baseline   = require('../models/Baseline');
const Catalog    = require('../models/DisciplineCatalog');
const SpecPreset = require('../models/SpecPreset');

/* ===== Utils ===== */
const N = v => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};
const S = v => String(v || '').trim();
const arrify = x => Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []);
function schoolYear() {
  const d = new Date(), y = d.getFullYear(), m = d.getMonth();
  return (m >= 7) ? `${y}-${y+1}` : `${y-1}-${y}`;
}

/* ===== Fallbacks locaux (si pas de presets Admin) ===== */
const CLASSES_BY_SPEC = {
  DECO: ['1ère année DECO','2ème année DECO','3ème année DECO','4ème année DECO'],
  AF1 : ['2nde AF1','1ère AF1','Tle AF1'],
  AF2 : ['2nde AF2','1ère AF2','Tle AF2'],
  AF3 : ['2nde AF3','1ère AF3','Tle AF3']
};
const CLASS_LEVELS = {
  premier: ['1ère année','2ème année','3ème année','4ème année'],
  second : ['Seconde','Première','Terminale']
};
function canonClasses(cycle, specialite){
  const spec = S(specialite).toUpperCase();
  const base = CLASS_LEVELS[S(cycle).toLowerCase()] || [];
  return base.map(lbl => `${lbl} ${spec}`.trim());
}

/* =========================================
   PARAMÈTRES ÉTABLISSEMENT
   ========================================= */

/**
 * GET /api/settings
 * Supporte ?etab= & ?annee= (sinon prend req.user + année scolaire courante)
 * Renvoie toujours un objet (même vide) pour simplifier le front.
 */
router.get('/', async (req, res, next) => {
  try {
    const u = req.user || {};
    const etabQ = S(req.query.etab);
    const etab  = etabQ || S(u.etab);
    const insp  = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee = S(req.query.annee) || schoolYear();

    if (!etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });

    const q = { inspection: insp, etablissement: etab, annee };
    const doc = await Settings.findOne(q).lean();

    if (!doc) {
      return res.json({
        inspection: insp, etablissement: etab, annee,
        effectifs: [], staff: []
      });
    }
    return res.json(doc);
  } catch (e) { next(e); }
});

/**
 * POST /api/settings
 * Upsert effectifs + staff pour l’AP connecté (année obligatoire)
 * Accepte staff “v1” (nom, grade, matiere, statut, obs) et “v2” (fiche complète).
 */
router.post('/', async (req, res, next) => {
  try {
    const u = req.user || {};
    const etab = S(u.etab);
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee = S(req.body?.annee) || schoolYear();

    if (!etab)  return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee) return res.status(400).json({ error: 'annee requise' });

    // effectifs: nettoie et normalise
    const effIn = arrify(req.body?.effectifs);
    const effectifs = effIn
      .map(e => ({
        classe : S(e?.classe),
        filles : N(e?.filles),
        garcons: N(e?.garcons)
      }))
      .filter(e => e.classe);

    // staff: compat v1 / v2
    const staffIn = arrify(req.body?.staff);
    const isStaffV2 = staffIn.some(s =>
      s?.matricule || s?.telephone || s?.categorie || s?.prenom ||
      s?.sexe || s?.dateNaissance || s?.dateEntreeFP || s?.dateAffectation ||
      s?.regionOrigine || s?.departementOrigine || s?.arrondissementOrigine ||
      s?.posteOccupe || s?.rangPoste
    );

    const staff = staffIn.map(s => {
      const base = {
        nom: S(s?.nom),
        grade: S(s?.grade),
        matiere: S(s?.matiere),
        statut: S(s?.statut),
        obs: S(s?.obs),
        classes: Array.isArray(s?.classes) ? s.classes.map(S).filter(Boolean) : [],
        disciplines: Array.isArray(s?.disciplines) ? s.disciplines.map(S).filter(Boolean) : []
      };
      if (!isStaffV2) return base;
      return {
        ...base,
        prenom: S(s?.prenom),
        matricule: S(s?.matricule),
        categorie: S(s?.categorie),
        sexe: S(s?.sexe),
        dateNaissance: S(s?.dateNaissance),
        telephone: S(s?.telephone),
        regionOrigine: S(s?.regionOrigine),
        departementOrigine: S(s?.departementOrigine),
        arrondissementOrigine: S(s?.arrondissementOrigine),
        posteOccupe: S(s?.posteOccupe),
        rangPoste: S(s?.rangPoste),
        dateEntreeFP: S(s?.dateEntreeFP),
        dateAffectation: S(s?.dateAffectation)
      };
    });

    const filter = { inspection: insp, etablissement: etab, annee };
    const update = {
      $set: { effectifs, staff },
      $setOnInsert: { inspection: insp, etablissement: etab, annee }
    };

    const doc = await Settings.findOneAndUpdate(filter, update, { new: true, upsert: true });
    res.json({ message: 'Paramètres enregistrés', id: String(doc._id) });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({
        error: 'Doublon de paramètres pour cet établissement et cette année (index uniq_insp_etab_annee).'
      });
    }
    next(e);
  }
});

/**
 * DELETE /api/settings/reset?annee=YYYY-YYYY
 * Efface settings + baselines de l’année
 */
router.delete('/reset', async (req, res, next) => {
  try {
    const u = req.user || {};
    const etab = S(u.etab);
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee = S(req.query.annee || req.body?.annee);

    if (!etab)  return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee) return res.status(400).json({ error: 'annee requise' });

    await Settings.deleteMany({ inspection: insp, etablissement: etab, annee });
    await Baseline.deleteMany({ etablissement: etab, annee });
    res.json({ message: `Paramétrage et baselines réinitialisés pour ${annee}.` });
  } catch (e) { next(e); }
});

/* =========================================
   PRESETS / DEFAULTS
   ========================================= */

/**
 * GET /api/settings/presets?cycle=&specialite=
 * (si ton front appelle /api/presets, monte aussi ce handler à /api/presets)
 */
router.get('/presets', async (req, res, next) => {
  try {
    const insp = S((req.user || {}).inspection || 'artsplastiques').toLowerCase();
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    if (!cycle || !specialite) return res.status(400).json({ error: 'cycle et specialite requis' });

    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite }).lean();
    const classes = (p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[specialite] || canonClasses(cycle, specialite)));
    res.json({ classes });
  } catch (e) { next(e); }
});

/**
 * GET /api/settings/effectifs/defaults?annee=&cycle=&specialite=
 * — aide à pré-remplir la modale (1 division par défaut + disciplines actives)
 */
router.get('/effectifs/defaults', async (req, res, next) => {
  try {
    const u = req.user || {};
    const etab = S(u.etab);
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    const annee = S(req.query.annee) || schoolYear();

    if (!etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite }).lean();
    const classes = p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[specialite] || canonClasses(cycle, specialite));

    const discs = await Catalog.find({ inspection: insp, cycle, specialite, actif: true })
      .sort({ ordre: 1, nom: 1 }).lean();
    const disciplines = (discs || []).map(d => d.nom);

    const payloadClasses = classes.map(name => ({
      canonicalClass: name,
      divisions: 1,
      effectifs: [{ divisionIndex: 1, filles: 0, garcons: 0 }],
      disciplines
    }));

    res.json({ ok: true, annee, cycle, specialite, classes: payloadClasses, disciplines });
  } catch (e) { next(e); }
});

/* =========================================
   BASELINES
   ========================================= */

/**
 * GET /api/settings/baselines?annee=&cycle=&specialite=
 * Renvoie locales si présentes sinon un “defaults recalculé” (0 partout)
 */
router.get('/baselines', async (req, res, next) => {
  try {
    const u = req.user || {};
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    const annee = S(req.query.annee) || schoolYear();

    if (!u.etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    const list = await Baseline.find({ etablissement: u.etab, annee, cycle, specialite }).lean();
    if (list.length) return res.json(list);

    // defaults si aucune baseline enregistrée
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite }).lean();
    const classes = p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[specialite] || []);
    const discs = await Catalog.find({ inspection: insp, cycle, specialite, actif: true })
      .sort({ ordre: 1, nom: 1 }).lean();

    const rows = [];
    for (const cl of classes) {
      for (const di of (discs || [])) {
        rows.push({
          etablissement: u.etab,
          annee, cycle, specialite,
          classe: cl, discipline: di.nom,
          heuresDues: 0, leconsPrevues: 0, leconsDigPrevues: 0,
          tpPrevus: 0,  tpDigPrevus: 0,  enseignantsPoste: 0
        });
      }
    }
    res.json(rows);
  } catch (e) { next(e); }
});

/**
 * GET /api/settings/baselines/defaults?annee=&cycle=&specialite=
 * (forcé “catalogue 0 partout”)
 */
router.get('/baselines/defaults', async (req, res, next) => {
  try {
    const u = req.user || {};
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    const annee = S(req.query.annee) || schoolYear();

    if (!u.etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!cycle || !specialite) return res.status(400).json({ error: 'cycle & specialite requis' });

    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite }).lean();
    const classes = p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[specialite] || []);

    const discs = await Catalog.find({ inspection: insp, cycle, specialite, actif: true })
      .sort({ ordre: 1, nom: 1 }).lean();

    const rows = [];
    classes.forEach(cl => {
      (discs || []).forEach(di => {
        rows.push({
          etablissement: u.etab,
          annee, cycle, specialite,
          classe: cl, discipline: di.nom,
          heuresDues: 0, leconsPrevues: 0, leconsDigPrevues: 0,
          tpPrevus: 0,  tpDigPrevus: 0,  enseignantsPoste: 0
        });
      });
    });
    res.json(rows);
  } catch (e) { next(e); }
});

/**
 * POST /api/settings/baselines
 * Body: { annee, cycle, specialite, list: [...]}  // compat
 *   ou   { annee, cycle, specialite, baselines: [...] }  // compat front existant
 */
router.post('/baselines', async (req, res, next) => {
  try {
    const u = req.user || {};
    const annee = S(req.body?.annee) || schoolYear();
    const cycle = S(req.body?.cycle);
    const specialite = S(req.body?.specialite).toUpperCase();

    // compat: accepte list[] ou baselines[]
    const raw = Array.isArray(req.body?.list) ? req.body.list
             : Array.isArray(req.body?.baselines) ? req.body.baselines
             : [];
    if (!u.etab)  return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });
    if (!raw.length) return res.json({ message: 'Aucune baseline à enregistrer' });

    const ops = raw
      .filter(r => S(r.classe) && S(r.discipline))
      .map(r => ({
        updateOne: {
          filter: {
            etablissement: u.etab, annee, cycle, specialite,
            classe: S(r.classe), discipline: S(r.discipline)
          },
          update: {
            $set: {
              heuresDues: N(r.heuresDues),
              leconsPrevues: N(r.leconsPrevues),
              leconsDigPrevues: N(r.leconsDigPrevues),
              tpPrevus: N(r.tpPrevus),
              tpDigPrevus: N(r.tpDigPrevus),
              enseignantsPoste: N(r.enseignantsPoste)
            }
          },
          upsert: true
        }
      }));

    if (!ops.length) return res.json({ message: 'Aucune ligne valide' });
    await Baseline.bulkWrite(ops, { ordered: false });
    res.json({ message: `${ops.length} baseline(s) enregistrée(s)` });
  } catch (e) { next(e); }
});

/**
 * DELETE /api/settings/baselines?annee=&cycle=&specialite=
 */
router.delete('/baselines', async (req, res, next) => {
  try {
    const u = req.user || {};
    const annee = S((req.query.annee || req.body?.annee)) || schoolYear();
    const cycle = S((req.query.cycle || req.body?.cycle));
    const specialite = S((req.query.specialite || req.body?.specialite)).toUpperCase();

    if (!u.etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    const r = await Baseline.deleteMany({ etablissement: u.etab, annee, cycle, specialite });
    res.json({ message: `${r.deletedCount || 0} baseline(s) supprimée(s)` });
  } catch (e) { next(e); }
});

module.exports = router;


