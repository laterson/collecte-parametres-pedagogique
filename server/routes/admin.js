// server/routes/admin.js
const express = require('express');
const bcrypt  = require('bcrypt');
const User    = require('../../models/User');
const fs        = require('fs');
const path      = require('path');

const Collecte  = require('../../models/Collecte');
const Settings  = require('../../models/Settings');
const Baseline  = require('../../models/Baseline');
const Teacher   = require('../../models/Teacher');
const Message   = require('../../models/Message');      // si présent
const SchoolCard= require('../../models/SchoolCard');   // si présent


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
// supprime un fichier d'uploads si le chemin est référencé
async function safeRmUpload(relPath){
  try{
    if(!relPath) return;
    const root = path.join(process.cwd(), 'uploads');
    const rel  = String(relPath).replace(/^\/+/, '');
    const abs  = path.resolve(root, rel);
    if (!abs.startsWith(root)) return;   // sécurité
    await fs.promises.rm(abs, { force:true });
  }catch(_){}
}

// récupère tous les chemins de fichiers stockés dans une collecte
function extractFilesFromCollecte(doc){
  const out = [];
  const all = []
    .concat(doc?.pieces   || [])
    .concat(doc?.fichiers || [])
    .concat(doc?.uploads  || [])
    .filter(Boolean);
  for (const f of all){
    if (typeof f === 'string') out.push(f);
    else if (f && typeof f === 'object') out.push(f.path || f.url || '');
  }
  return out.filter(Boolean);
}

// purge complète d'un établissement pour une inspection donnée
async function purgeEstablishment({ inspection, etablissement }){
  const insp = String(inspection||'').toLowerCase();
  const etab = String(etablissement||'').trim();

  // collectes pour lister les fichiers
  const collectes = await Collecte.find({ inspection: insp, etablissement: etab })
    .select('pieces fichiers uploads')
    .lean();
  const files = collectes.flatMap(extractFilesFromCollecte);

  // suppressions en base
  const r = {};
  r.settings   = await Settings.deleteMany({ inspection: insp, etablissement: etab });
  r.collectes  = await Collecte.deleteMany({ inspection: insp, etablissement: etab });
  r.baselines  = await Baseline.deleteMany({ etablissement: etab });
  r.teachers   = await Teacher.deleteMany({ inspection: insp, etablissement: etab });
  try { r.schoolCard = await SchoolCard.deleteMany({ etablissement: etab }); } catch(_) {}
  try { r.messages   = await Message.deleteMany({ $or:[
    { etablissement: etab }, { fromEtab: etab }, { toEtab: etab } ]}); } catch(_){}

  // fichiers (hors transaction)
  await Promise.all(files.map(safeRmUpload));

  return {
    deleted: {
      settings   : r.settings?.deletedCount   || 0,
      collectes  : r.collectes?.deletedCount  || 0,
      baselines  : r.baselines?.deletedCount  || 0,
      teachers   : r.teachers?.deletedCount   || 0,
      schoolCard : r.schoolCard?.deletedCount || 0,
      messages   : r.messages?.deletedCount   || 0,
      files      : files.length
    }
  };
}


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

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: 'not found' });

    const purgeAll = String(req.query.purge || '0') === '1';
    const force    = String(req.query.force || '0') === '1';

    let report = { userDeleted:false, purge:null };

    if (purgeAll && !force) {
      const others = await User.countDocuments({
        _id:{ $ne: user._id },
        inspection: (user.inspection||'').toLowerCase(),
        etablissement: user.etablissement
      });
      if (others > 0) {
        return res.status(409).json({
          error: `Il reste ${others} autre(s) utilisateur(s) sur l'établissement « ${user.etablissement} ». Ajoute &force=1 pour purger quand même.`
        });
      }
    }

    if (purgeAll) {
      report.purge = await purgeEstablishment({
        inspection: user.inspection,
        etablissement: user.etablissement
      });
    }

    await User.deleteOne({ _id: user._id });
    report.userDeleted = true;

    res.json({
      message: 'Utilisateur supprimé' + (purgeAll ? ' et établissement purgé' : ''),
      inspection: user.inspection,
      etablissement: user.etablissement,
      ...report
    });
  } catch (e) { next(e); }
});


// DELETE /admin/establishments?inspection=artsplastiques&etablissement=LTB%20NSAM&force=1
router.delete('/establishments', async (req, res, next) => {
  try {
    const inspection    = String(req.query.inspection||'').toLowerCase();
    const etablissement = String(req.query.etablissement||'').trim();
    const force         = String(req.query.force||'0') === '1';
    if (!inspection || !etablissement)
      return res.status(400).json({ error:'inspection et etablissement requis' });

    if (!force) {
      const users = await User.countDocuments({ inspection, etablissement });
      if (users > 0) {
        return res.status(409).json({ error:`${users} utilisateur(s) existent encore pour cet établissement. Ajoute &force=1 pour purger quand même.` });
      }
    }

    const report = await purgeEstablishment({ inspection, etablissement });
    res.json({ message:'Établissement purgé', inspection, etablissement, ...report });
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
