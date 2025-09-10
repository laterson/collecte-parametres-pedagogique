// server/routes/messages.js
const express = require('express');
const Message = require('../../models/Message');

const router = express.Router();

/**
 * GET /api/messages
 * Historique des messages dans l’inspection courante
 * Query: ?limit=50&etablissement=...
 * (le cloisonnement /api global applique déjà requireAuth + limitToInspection())
 */
router.get('/', async (req, res, next) => {
  try {
    const insp = String(req.user?.inspection || '').toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const etab = (req.query.etablissement || '').toString().trim();

    const q = { inspection: insp };
    if (etab) q.etablissement = etab;

    const rows = await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(rows.reverse());
  } catch (e) { next(e); }
});

module.exports = router;
