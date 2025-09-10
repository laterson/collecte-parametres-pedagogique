// server/routes/admin.js
const express = require('express');
const bcrypt  = require('bcrypt');
const User    = require('../../models/User');

const router = express.Router();

/* ===== Helpers ===== */
const norm = s => String(s ?? '').trim();
const lc   = s => norm(s).toLowerCase();

/* Auth guard (admin only) */
function ensureAdmin(req, res, next) {
  const u = req.user || req.session?.user;
  if (!u) return res.status(401).json({ error: 'auth required' });
  if (u.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  // expose a consistent user object
  req.user = u;
  next();
}

router.use(ensureAdmin);

/* ===== LISTE UTILISATEURS =====
   GET /admin/users?inspection=&departement=&q=
   - recherche sur nom/email/etablissement/departement (insensible à la casse)
*/
router.get('/users', async (req, res, next) => {
  try {
    const { inspection, departement, q } = req.query || {};
    const f = {};
    if (inspection)  f.inspection  = lc(inspection);
    if (departement) f.departement = norm(departement);

    if (q && q.trim()) {
      const rx = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      f.$or = [
        { nomComplet: rx },
        { email: rx },
        { etablissement: rx },
        { departement: rx }
      ];
    }

    const users = await User.find(f)
      .select('_id nomComplet email etablissement departement departementCode role inspection')
      .sort({ role: 1, nomComplet: 1 })
      .lean();

    res.json(users);
  } catch (e) { next(e); }
});

/* ===== SUPPRESSION UTILISATEUR ===== */
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (String(id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Impossible de supprimer votre propre compte.' });
    }
    const doc = await User.findById(id);
    if (!doc) return res.status(404).json({ error: 'not found' });
    await User.deleteOne({ _id: id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ===== MISE À JOUR UTILISATEUR =====
   - champs éditables: nomComplet, email, etablissement, departement(+code), role, inspection, password
*/
router.put('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const u = await User.findById(id);
    if (!u) return res.status(404).json({ error: 'not found' });

    const nextRole = norm(req.body.role) || u.role;
    if (!['anim','insp','admin'].includes(nextRole)) {
      return res.status(400).json({ error: 'role invalide' });
    }

    const nextInspection = lc(req.body.inspection || u.inspection);

    const nextEmail = lc(req.body.email || u.email);
    if (nextEmail && nextEmail !== u.email) {
      const exists = await User.exists({ email: nextEmail, _id: { $ne: u._id } });
      if (exists) return res.status(400).json({ error: 'Email déjà utilisé.' });
      u.email = nextEmail;
    }

    u.nomComplet     = norm(req.body.nomComplet || req.body.nom) || u.nomComplet;
    u.etablissement  = norm(req.body.etablissement) ?? u.etablissement;
    u.departement    = norm(req.body.departement)   ?? u.departement;
    u.departementCode= norm(req.body.departementCode) ?? u.departementCode;
    u.role           = nextRole;
    u.inspection     = nextInspection || u.inspection;

    const pwd = norm(req.body.password);
    if (pwd) u.passwordHash = await bcrypt.hash(pwd, 12);

    await u.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ===== CHANGER EMAIL / MDP ADMIN COURANT ===== */
router.post('/changePass', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ error: 'not found' });

    if (email) {
      const newEmail = lc(email);
      if (newEmail !== me.email) {
        const exists = await User.exists({ email: newEmail, _id: { $ne: me._id } });
        if (exists) return res.status(400).json({ error: 'Email déjà utilisé.' });
        me.email = newEmail;
      }
    }
    if (password) {
      me.passwordHash = await bcrypt.hash(String(password), 12);
    }
    await me.save();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
