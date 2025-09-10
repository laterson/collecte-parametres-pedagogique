// routes/settings.js
const express    = require('express');
const router     = express.Router();
const Settings   = require('../models/Settings');
const Baseline   = require('../models/Baseline');
const Catalog    = require('../models/DisciplineCatalog');
const SpecPreset = require('../models/SpecPreset');
const { isAuth } = require('../middleware/authsuupr');

// Fallback local (si pas de preset Admin)
const CLASSES_BY_SPEC = {
  DECO: ['1ère année DECO','2ème année DECO','3ème année DECO','4ème année DECO'],
  AF1 : ['2nde AF1','1ère AF1','Tle AF1'],
  AF2 : ['2nde AF2','1ère AF2','Tle AF2'],
  AF3 : ['2nde AF3','1ère AF3','Tle AF3']
};
router.use(isAuth);

const CLASS_LEVELS = {
  premier: ['1ère année','2ème année','3ème année','4ème année'],
  second : ['Seconde','Première','Terminale']
};
function canonClasses(cycle, specialite){
  const spec = String(specialite||'').toUpperCase().trim();
  const base = CLASS_LEVELS[String(cycle||'').toLowerCase()] || [];
  return base.map(lbl => `${lbl} ${spec}`.trim());
}

// petit util
const N = v => Number(v || 0);
const S = v => String(v || '').trim();

/* ========= PARAMÈTRES ÉTABLISSEMENT ========= */
// Récupérer les paramètres (dernier doc de l’année si précisée)
router.get('/', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const etab = S(u.etab);
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee = S(req.query.annee);

    if (!etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });

    const q = { inspection: insp, etablissement: etab };
    if (annee) q.annee = annee;

    const doc = await Settings.findOne(q).sort({ createdAt: -1 }).lean();
    if (!doc) return res.status(404).json({ error: 'not found' });
    res.json(doc);
  } catch (e) { next(e); }
});

// Créer / Mettre à jour (upsert) pour l’AP connecté
// Créer / Mettre à jour (upsert) pour l’AP connecté — compatible divisions
router.post('/', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const etab = S(u.etab);
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee = S(req.body?.annee);
    const cycle = S(req.body?.cycle);
    const specialite = S(req.body?.specialite).toUpperCase();

    if (!etab)  return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee) return res.status(400).json({ error: 'annee requise' });

    // === 2 formats possibles ===
    // A) NOUVEAU: body.classes = [{ canonicalClass, divisions, effectifs:[{divisionIndex, filles, garcons}], disciplines:[...] }]
    // B) ANCIEN : body.effectifs = [{ classe, filles, garcons }] (+ body.staff = [...])
    const CLASSES_IN = Array.isArray(req.body?.classes) ? req.body.classes : null;

    let effectifsOut = [];
    let disciplinesByClass = [];
    if (CLASSES_IN && CLASSES_IN.length) {
      for (const C of CLASSES_IN) {
        const cname = S(C.canonicalClass);
        const divN  = Math.max(1, Number(C.divisions || 1));
        const eff   = Array.isArray(C.effectifs) ? C.effectifs : [];
        for (let i = 1; i <= divN; i++) {
          const row = eff.find(x => Number(x.divisionIndex) === i) || {};
          effectifsOut.push({
            classe: cname,
            divisionIndex: i,
            filles : N(row.filles),
            garcons: N(row.garcons)
          });
        }
        const dlist = Array.isArray(C.disciplines) ? C.disciplines.map(S).filter(Boolean) : [];
        disciplinesByClass.push({ classe: cname, disciplines: Array.from(new Set(dlist)) });
      }
    } else {
      // Compat ancien format: pas de divisions → on crée divisionIndex=1
      const effectifs = Array.isArray(req.body?.effectifs) ? req.body.effectifs : [];
      effectifsOut = effectifs
        .map(c => ({
          classe: S(c.classe),
          divisionIndex: 1,
          filles: N(c.filles),
          garcons: N(c.garcons)
        }))
        .filter(c => c.classe);
      // Pas d’info disciplines par classe dans l’ancien format
      disciplinesByClass = [];
    }

    // Fichier(s) du personnel (optionnel)
    const staffIn   = Array.isArray(req.body?.staff)      ? req.body.staff      : [];
    const staffFiles= Array.isArray(req.body?.staffFiles) ? req.body.staffFiles : [];
    const stf = staffIn.map(s => ({
      nom       : S(s.nom),
      grade     : S(s.grade),
      matiere   : S(s.matiere),
      statut    : S(s.statut),
      obs       : S(s.obs),
      classes    : Array.isArray(s.classes)     ? s.classes.map(S).filter(Boolean)     : [],
      disciplines: Array.isArray(s.disciplines) ? s.disciplines.map(S).filter(Boolean) : []
    }));

    const filter = { inspection: insp, etablissement: etab, annee };
    const update = {
      $set: {
        cycle: cycle || undefined,
        specialite: specialite || undefined,
        effectifs: effectifsOut,           // ← désormais par division
        staff: stf,
        staffFiles,                        // ← optionnel pour stocker les fichiers personnels
        // Ajouté : mapping disciplines par classe (si fourni en nouveau format)
        ...(disciplinesByClass.length ? { disciplinesByClass } : {})
      },
      $setOnInsert: { inspection: insp, etablissement: etab, annee }
    };

    const doc = await Settings.findOneAndUpdate(filter, update, { new: true, upsert: true });
    res.json({ message: 'Paramètres enregistrés', id: String(doc._id) });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({
        error: 'Doublon de paramètres pour cet établissement et cette année (index uniq_insp_etab_annee). Supprime l’ancien index et/ou les doublons puis réessaie.'
      });
    }
    next(e);
  }
});

/* ========= RESET GLOBAL (année) ========= */
router.delete('/reset', async (req, res, next) => {
  try {
    const u = req.session.user || {};
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

/* ========= PRESETS : classes par spé ========= */
router.get('/presets', async (req, res, next) => {
  try {
    const insp = S((req.session.user || {}).inspection || 'artsplastiques').toLowerCase();
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    if (!cycle || !specialite) return res.status(400).json({ error: 'cycle et specialite requis' });

    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite }).lean();
    const classes = (p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[specialite] || []));
    res.json({ classes });
  } catch (e) { next(e); }
});
/* ========= EFFECTIFS DEFAULTS (pour la modale AP) ========= */
// Renvoie les classes canoniques + 1 division par défaut et la liste des disciplines actives
router.get('/effectifs/defaults', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const etab = S(u.etab);
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    const annee = S(req.query.annee);

    if (!etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    // Classes depuis preset admin (fallback local si besoin)
    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite }).lean();
    const classes = p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[specialite] || canonClasses(cycle, specialite));

    // Disciplines actives du catalogue
    const discs = await Catalog.find({ inspection: insp, cycle, specialite, actif: true })
      .sort({ ordre: 1, nom: 1 }).lean();
    const disciplines = (discs || []).map(d => d.nom);

    // Structure par défaut pour la modale (divisions=1)
    const payloadClasses = classes.map(name => ({
      canonicalClass: name,
      divisions: 1,
      effectifs: [{ divisionIndex: 1, filles: 0, garcons: 0 }],
      disciplines       // toutes cochées par défaut; le front pourra décocher par classe
    }));

    res.json({ ok: true, annee, cycle, specialite, classes: payloadClasses, disciplines });
  } catch (e) { next(e); }
});

/* ========= BASELINES ========= */
// defaults = classes (preset admin) × disciplines actives du catalogue
router.get('/baselines/defaults', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const insp = S(u.inspection || 'artsplastiques').toLowerCase();
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    const annee = S(req.query.annee);

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

// lire baselines ; sinon defaults recalculés
router.get('/baselines', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const cycle = S(req.query.cycle);
    const specialite = S(req.query.specialite).toUpperCase();
    const annee = S(req.query.annee);

    if (!u.etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    const list = await Baseline.find({ etablissement: u.etab, annee, cycle, specialite }).lean();
    if (list.length) return res.json(list);

    // recalculer défauts si aucune baseline enregistrée
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

// upsert baselines
router.post('/baselines', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const annee = S(req.body?.annee);
    const cycle = S(req.body?.cycle);
    const specialite = S(req.body?.specialite).toUpperCase();
    const list = Array.isArray(req.body?.list) ? req.body.list : [];

    if (!u.etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });
    if (!list.length) return res.json({ message: 'Aucune baseline à enregistrer' });

    const ops = list
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
    await Baseline.bulkWrite(ops);
    res.json({ message: `${ops.length} baseline(s) enregistrée(s)` });
  } catch (e) { next(e); }
});

// suppression baselines
router.delete('/baselines', async (req, res, next) => {
  try {
    const u = req.session.user || {};
    const annee = S((req.query.annee || req.body?.annee));
    const cycle = S((req.query.cycle || req.body?.cycle));
    const specialite = S((req.query.specialite || req.body?.specialite)).toUpperCase();

    if (!u.etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !specialite) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    const r = await Baseline.deleteMany({ etablissement: u.etab, annee, cycle, specialite });
    res.json({ message: `${r.deletedCount || 0} baseline(s) supprimée(s)` });
  } catch (e) { next(e); }
});

module.exports = router;
