// routes/parametrage.js
const express = require('express');
const router = express.Router();

const Settings   = require('../models/Settings');
const Baseline   = require('../models/Baseline');
const SpecPreset = require('../models/SpecPreset');
// ⬇️ Ajuste ce require si ton modèle a un autre nom
const Catalog    = require('../models/DisciplineCatalog');

/* ------------- Utils ------------- */
const S = v => String(v || '').trim();
const N = v => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};
const toSPEC  = s => S(s).toUpperCase();
const toCycle = s => {
  const c = S(s).toLowerCase();
  return (c === 'premier' || c === 'second') ? c : c;
};

// splitClassLabel sécurisé (fallback local)
let splitClassLabel;
try {
  const mod = require('../server/utils/splitClassLabel');
  splitClassLabel = typeof mod === 'function' ? mod : mod?.splitClassLabel;
} catch (_) { /* ignore */ }
if (typeof splitClassLabel !== 'function') {
  splitClassLabel = function(label){
    const raw = S(label);
    if (!raw) return { base: '', division: 1, label: '' };
    const m = raw.match(/\s*(?:\(|#|-|\/)\s*(\d+)\s*\)?\s*$/);
    if (!m) return { base: raw, division: 1, label: raw };
    const div  = Number(m[1] || '1') || 1;
    const base = raw.slice(0, m.index).trim();
    return { base, division: div, label: `${base} (${div})` };
  };
}

// Fallback local au cas où l’admin n’a pas créé de preset
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
  const spec = toSPEC(specialite);
  const base = CLASS_LEVELS[toCycle(cycle)] || [];
  return base.map(lbl => `${lbl} ${spec}`.trim());
}

/* ========= /structure : cycles + spécialités dispo ========= */
// GET /api/parametrage/structure
router.get('/structure', async (req, res, next) => {
  try {
    const insp = S(req.user?.inspection || 'artsplastiques').toLowerCase();
    const presets = await SpecPreset.find({ inspection: insp }).lean();

    const byCycle = new Map();
    for (const p of (presets || [])) {
      const cyc = S(p.cycle);
      const sp  = toSPEC(p.specialite);
      if (!cyc || !sp) continue;
      if (!byCycle.has(cyc)) byCycle.set(cyc, new Set());
      byCycle.get(cyc).add(sp);
    }

    const cycles = Array.from(byCycle.entries()).map(([key, set]) => ({
      key,
      label: key === 'premier' ? 'Premier cycle' : 'Second cycle',
      specialites: Array.from(set).sort()
    })).sort((a,b)=> a.key.localeCompare(b.key));

    res.json({ cycles });
  } catch (e) { next(e); }
});

/* ========= /load : payload complet après choix cycle+spé ========= */
/*
  GET /api/parametrage/load?annee=&cycle=&specialite=
  => {
      ok:true,
      annee, cycle, specialite,
      classesDisponibles: [{ canonicalClass, divisions }], // panel de gauche
      effectifs: [{ classe:'X (1)', filles, garcons }],   // tableau effectifs
      baselines: { classes:[ 'X (1)', ... ],
                   rows:[{classe,discipline,heuresDues,leconsPrevues,leconsDigPrevues,tpPrevus,tpDigPrevus,enseignantsPoste}]},
      staff: [{nom,grade,matiere,statut,obs}],
      catalogDisciplines: ['Maths', ...] // pour “charger défauts”
    }
*/
router.get('/load', async (req, res, next) => {
  try {
    const u       = req.user || {};
    const etab    = S(u.etab);
    const insp    = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee   = S(req.query.annee);
    const cycle   = toCycle(req.query.cycle);
    const spec    = toSPEC(req.query.specialite);

    if (!etab)  return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !spec) {
      return res.status(400).json({ error: 'annee, cycle, specialite requis' });
    }

    // 1) Presets classes + catalogue de disciplines actives
    const p = await SpecPreset.findOne({ inspection: insp, cycle, specialite: spec }).lean();
    const classesPreset = p?.classes?.length ? p.classes : (CLASSES_BY_SPEC[spec] || canonClasses(cycle, spec));

    const discs = await Catalog.find({ inspection: insp, cycle, specialite: spec, actif: true })
      .sort({ ordre: 1, nom: 1 }).lean();
    const catalogDisciplines = (discs || []).map(d => d.nom);

    // 2) Settings de l’AP (année)
    const Sdoc = await Settings.findOne({ inspection: insp, etablissement: etab, annee })
      .lean();

    const staff = Array.isArray(Sdoc?.staff) ? Sdoc.staff : [];

    // Reconstruit classes FULL (avec divisions) à partir des effectifs sauvegardés si dispo
    const setFullLabels = new Set();
    if (Array.isArray(Sdoc?.effectifs) && Sdoc.effectifs.length) {
      for (const e of Sdoc.effectifs) {
        if (e?.classe) { // V1
          const lbl = S(e.classe);
          if (lbl) setFullLabels.add(lbl);
          continue;
        }
        // V2 (canonical + divisions / effectifs[])
        const base = S(e?.canonicalClass);
        if (!base) continue;
        const divCount = Number(e?.divisions) ||
                         (Array.isArray(e?.effectifs) ? e.effectifs.length : 1) || 1;
        for (let i=1;i<=divCount;i++){
          setFullLabels.add(i === 1 ? base : `${base} (${i})`);
        }
      }
    }

    // Si rien en base, on part du preset (1 division par base)
    if (!setFullLabels.size) {
      for (const base of classesPreset) setFullLabels.add(base);
    }

    // 3) Effectifs (tableau) — on renvoie F/G depuis Sdoc si possible
    const effRows = [];
    if (Array.isArray(Sdoc?.effectifs) && Sdoc.effectifs.length) {
      // V1 : une ligne par division
      for (const e of Sdoc.effectifs) {
        if (e?.classe) {
          effRows.push({
            classe : S(e.classe),
            filles : N(e.filles),
            garcons: N(e.garcons)
          });
        }
      }
      // V2 : canonical + effectifs[] => aplatir
      for (const e of Sdoc.effectifs) {
        if (!e?.classe && e?.canonicalClass) {
          const base = S(e.canonicalClass);
          const list = Array.isArray(e.effectifs) ? e.effectifs : [{ divisionIndex: 1, filles: e.filles, garcons: e.garcons }];
          for (let i=0;i<list.length;i++){
            const di = list[i] || {};
            const lbl = i===0 ? base : `${base} (${i+1})`;
            effRows.push({ classe: lbl, filles: N(di.filles), garcons: N(di.garcons) });
          }
        }
      }
    } else {
      // pas d’effectifs enregistrés : table vide mais lignes prêtes si tu veux (ici on laisse vide)
      // Tu peux décommenter pour pré-créer des lignes à 0 :
      // for (const full of setFullLabels) effRows.push({ classe: full, filles: 0, garcons: 0 });
    }

    // 4) Baselines — lire enregistrées pour le couple
    const B = await Baseline.find({
      inspection: insp, etablissement: etab, annee, cycle, specialite: spec
    }).lean();

    // classes list (colonne de gauche des baselines)
    const baselineClassSet = new Set();
    (B || []).forEach(r => r?.classe && baselineClassSet.add(S(r.classe)));
    // si aucune baseline en base => classes depuis preset
    if (!baselineClassSet.size) classesPreset.forEach(c => baselineClassSet.add(c));

    const baselines = {
      classes: Array.from(baselineClassSet).sort((a,b)=>a.localeCompare(b,'fr')),
      rows: (B || []).map(r => ({
        classe: S(r.classe),
        discipline: S(r.discipline),
        heuresDues: N(r.heuresDues),
        leconsPrevues: N(r.leconsPrevues),
        leconsDigPrevues: N(r.leconsDigPrevues),
        tpPrevus: N(r.tpPrevus),
        tpDigPrevus: N(r.tpDigPrevus),
        enseignantsPoste: N(r.enseignantsPoste)
      }))
    };

    // 5) Classes disponibles (panneau “avec divisions”)
    // Regrouper par base -> compter divisions
    const byBase = new Map(); // base -> Set(div)
    for (const lbl of setFullLabels) {
      if (!lbl) continue;
      const { base, division } = splitClassLabel(lbl);
      if (!base) continue;
      if (!byBase.has(base)) byBase.set(base, new Set());
      byBase.get(base).add(division || 1);
    }
    const classesDisponibles = [...byBase.entries()].map(([base, set]) => ({
      canonicalClass: base,
      divisions: set.size || 1
    })).sort((a,b)=> a.canonicalClass.localeCompare(b.canonicalClass,'fr'));

    res.json({
      ok: true,
      annee, cycle, specialite: spec,
      classesDisponibles,
      effectifs: effRows,
      baselines,
      staff,
      catalogDisciplines
    });
  } catch (e) { next(e); }
});

/* ========= Save global ========= */
// POST /api/parametrage/save
// body: { annee, effectifs:[], staff:[], disciplinesByClass:[] }  (V1 compatibles)
router.post('/save', async (req, res, next) => {
  try {
    const u     = req.user || {};
    const etab  = S(u.etab);
    const insp  = S(u.inspection || 'artsplastiques').toLowerCase();
    const annee = S(req.body?.annee);

    if (!etab)  return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee) return res.status(400).json({ error: 'annee requise' });

    const effectifsIn = Array.isArray(req.body?.effectifs) ? req.body.effectifs : [];
    const staffIn     = Array.isArray(req.body?.staff) ? req.body.staff : [];
    const discMapIn   = Array.isArray(req.body?.disciplinesByClass) ? req.body.disciplinesByClass : [];

    const eff = effectifsIn
      .map(e => ({ classe: S(e.classe), filles: N(e.filles), garcons: N(e.garcons) }))
      .filter(e => e.classe);

    const staff = staffIn
      .map(s => ({
        nom: S(s.nom || s.nomComplet),
        grade: S(s.grade), matiere: S(s.matiere), statut: S(s.statut), obs: S(s.obs)
      }))
      .filter(s => s.nom || s.grade || s.matiere || s.statut || s.obs);

    const discMap = discMapIn.map(r => ({
      classe: S(r.classe),
      disciplines: Array.isArray(r.disciplines) ? r.disciplines.map(S) : []
    })).filter(r => r.classe.length >= 0);

    const doc = await Settings.findOneAndUpdate(
      { inspection: insp, etablissement: etab, annee },
      { $set: { inspection: insp, etablissement: etab, annee, effectifs: eff, staff, disciplinesByClass: discMap } },
      { upsert: true, new: true }
    );

    res.json({ ok: true, message: 'Paramètres enregistrés', id: String(doc._id) });
  } catch (e) { next(e); }
});

/* ========= Baselines : lecture ========= */
// GET /api/parametrage/baselines?annee=&cycle=&specialite=
router.get('/baselines', async (req, res, next) => {
  try {
    const u     = req.user || {};
    const insp  = S(u.inspection || 'artsplastiques').toLowerCase();
    const etab  = S(u.etab);
    const annee = S(req.query.annee);
    const cycle = toCycle(req.query.cycle);
    const spec  = toSPEC(req.query.specialite);

    if (!etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !spec) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    const rows = await Baseline.find({ inspection: insp, etablissement: etab, annee, cycle, specialite: spec }).lean();
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/* ========= Baselines : écriture (remplacement) ========= */
// POST /api/parametrage/baselines
// body: { annee, cycle, specialite, rows: [{classe,discipline, ...}] }
router.post('/baselines', async (req, res, next) => {
  try {
    const u     = req.user || {};
    const insp  = S(u.inspection || 'artsplastiques').toLowerCase();
    const etab  = S(u.etab);

    const annee = S(req.body?.annee);
    const cycle = toCycle(req.body?.cycle);
    const spec  = toSPEC(req.body?.specialite);
    const rows  = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!etab) return res.status(403).json({ error: 'Profil AP incomplet (etablissement manquant)' });
    if (!annee || !cycle || !spec) return res.status(400).json({ error: 'annee, cycle, specialite requis' });

    // Remplacement total pour le couple
    await Baseline.deleteMany({ inspection: insp, etablissement: etab, annee, cycle, specialite: spec });

    if (rows.length) {
      const toInsert = rows
        .map(r => ({
          inspection: insp,
          etablissement: etab,
          annee, cycle, specialite: spec,
          classe: S(r.classe),
          discipline: S(r.discipline || r.nom),
          heuresDues: N(r.heuresDues || r.hD),
          leconsPrevues: N(r.leconsPrevues || r.lp),
          leconsDigPrevues: N(r.leconsDigPrevues || r.ldp),
          tpPrevus: N(r.tpPrevus || r.tp),
          tpDigPrevus: N(r.tpDigPrevus || r.tdp),
          enseignantsPoste: N(r.enseignantsPoste || r.effTot)
        }))
        .filter(x => x.classe && x.discipline);
      if (toInsert.length) await Baseline.insertMany(toInsert);
    }

    res.json({ ok: true, message: 'Baselines enregistrées' });
  } catch (e) { next(e); }
});

module.exports = router;
