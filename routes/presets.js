const express = require('express');
const router = express.Router();
const SpecPreset = require('../models/SpecPreset');
const { buildCanonicalNames } = require('../utils/canonicalClasses');

// Accès admin uniquement pour écrire
function isAdmin(req, res, next) {
  return req.session?.user?.role === 'admin'
    ? next()
    : res.status(403).json({ error: 'admin only' });
}

/**
 * GET /api/presets?inspection=&cycle=&specialite=
 * → { classes: [...] }
 */
router.get('/', async (req, res, next) => {
  try {
    let { inspection, cycle, specialite } = req.query;
    if (!inspection || !cycle || !specialite) {
      return res.status(400).json({ error: 'inspection, cycle, specialite requis' });
    }
    const SPEC = String(specialite).toUpperCase();
    const doc = await SpecPreset.findOne({ inspection, cycle, specialite: SPEC }).lean();
    res.json({ classes: doc?.classes || [] });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/presets/generate?inspection=&cycle=&specialite=
 * → génère la liste canonique (sans l’enregistrer si tu veux juste prévisualiser)
 * Add query param save=true pour sauvegarder aussi
 */
router.get('/generate', isAdmin, async (req, res, next) => {
  try {
    const { inspection, cycle, specialite, save } = req.query || {};
    if (!inspection || !cycle || !specialite) {
      return res.status(400).json({ error: 'inspection, cycle, specialite requis' });
    }
    const SPEC = String(specialite).toUpperCase();

    const classes = buildCanonicalNames(cycle, SPEC);
    if (!classes.length) {
      return res.status(400).json({ error: 'cycle invalide (attendu: "premier" ou "second")' });
    }

    if (String(save||'').toLowerCase()==='true'){
      const doc = await SpecPreset.findOneAndUpdate(
        { inspection, cycle, specialite: SPEC },
        { $set: { classes } },
        { new: true, upsert: true }
      );
      return res.json({ message: 'Preset généré et enregistré', classes: doc.classes });
    }

    res.json({ message: 'Aperçu généré (non enregistré)', classes });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/presets
 * body: { inspection, cycle, specialite, classes?: string[], auto?: boolean }
 * - si auto=true, ignore classes et génère automatiquement (puis enregistre)
 */
router.post('/', isAdmin, async (req, res, next) => {
  try {
    let { inspection, cycle, specialite, classes, auto } = req.body || {};
    if (!inspection || !cycle || !specialite) {
      return res.status(400).json({ error: 'inspection, cycle, specialite requis' });
    }
    const SPEC = String(specialite).toUpperCase();

    let list = [];
    if (String(auto||'').toLowerCase()==='true') {
      list = buildCanonicalNames(cycle, SPEC);
      if (!list.length) {
        return res.status(400).json({ error: 'cycle invalide (attendu: "premier" ou "second")' });
      }
    } else {
      list = Array.isArray(classes)
        ? classes.map(c => String(c || '').trim()).filter(Boolean)
        : [];
    }

    const doc = await SpecPreset.findOneAndUpdate(
      { inspection, cycle, specialite: SPEC },
      { $set: { classes: list } },
      { new: true, upsert: true }
    );

    res.json({ message: 'Preset enregistré', classes: doc.classes });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
