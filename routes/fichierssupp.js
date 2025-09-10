// routes/fichiers.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Fichier = require('../models/Fichier');
const { isAuth, isInsp, isAnim } = require('../middleware/auth');

const router = express.Router();

/* Répertoire uploads */
const root = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(root)) fs.mkdirSync(root);

const safe = s => String(s || '').replace(/[^\p{L}\p{N}\-_. ]/gu, '_');
const publicUrl = row => `/uploads/${safe(row.etablissement||'autre')}/${row.filename}`;

/* Multer storage */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(root, safe(req.session?.user?.etab || 'autre'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, ts + '__' + safe(file.originalname));
  }
});
const uploadAny = multer({ storage }).any();

/* Vues animateur */
router.get('/', isAuth, isAnim, async (req, res) => {
  const u = req.session.user;
  const rowsRaw = await Fichier.find({
    $or: [{ portee: 'tous' }, { portee: 'etab', etablissement: u.etab }]
  }).sort('-createdAt').lean();
  const rows = rowsRaw.map(r => ({ ...r, url: publicUrl(r) }));
  res.render('fichier_liste', { user:u, rows });
});

router.get('/upload', isAuth, isAnim, (req, res) => {
  res.render('fichier_upload', { user: req.session.user });
});

/* Upload */
router.post('/upload', isAuth, uploadAny, async (req, res) => {
  try{
    const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    if (!files.length) return res.status(400).json({ error: 'Aucun fichier' });

    const etab       = req.session.user.etab;
    const specialite = req.body.specialite || '';
    const evaluation = req.body.evaluation ? Number(req.body.evaluation) : undefined;
    const categorie  = req.body.categorie || 'Autre';
    const description= req.body.description || '';
    const portee     = req.body.portee === 'tous' ? 'tous' : 'etab';

    const saved = [];
    for (const f of files) {
      const doc = await Fichier.create({
        originalName: f.originalname,
        filename: f.filename,
        path: f.path,
        size: f.size,
        mimetype: f.mimetype,
        categorie, description,
        etablissement: etab,
        specialite, evaluation,
        portee,
        uploader: { id: req.session.user.id, nom: req.session.user.nom }
      });
      saved.push({ id:doc._id, name:doc.originalName, size:doc.size, url:publicUrl(doc), createdAt:doc.createdAt });
    }

    req.app.get('io')?.emit('files:changed', { by:req.session.user.nom, count:saved.length });
    res.status(201).json({ files: saved });
  }catch(e){
    res.status(500).json({ error:e.message });
  }
});

/* JSON short list */
router.get('/list', isAuth, async (req, res) => {
  const u = req.session.user;
  const rows = await Fichier.find({
    $or: [{ portee: 'tous' }, { portee: 'etab', etablissement: u.etab }]
  }).sort('-createdAt').limit(200).lean();

  res.json(rows.map(r => ({
    id:r._id, name:r.originalName, size:r.size, url:publicUrl(r),
    createdAt:r.createdAt, specialite:r.specialite||'', etablissement:r.etablissement||'', categorie:r.categorie||'Autre'
  })));
});

/* JSON all (IPR) */
router.get('/list-all', isAuth, isInsp, async (_req, res) => {
  const rows = await Fichier.find({}).sort('-createdAt').lean();
  res.json(rows.map(r => ({
    id:r._id, name:r.originalName, size:r.size, url:publicUrl(r), createdAt:r.createdAt,
    etablissement:r.etablissement, specialite:r.specialite||'', categorie:r.categorie||'Autre',
    evaluation:r.evaluation, portee:r.portee||'etab'
  })));
});

/* Download (autorisation AP/IPR) */
router.get('/:id/download', isAuth, async (req, res) => {
  const f = await Fichier.findById(req.params.id);
  if (!f) return res.status(404).send('Introuvable');

  const u = req.session.user;
  const isInspector = u.role === 'insp';
  const isSameEtab  = f.etablissement === u.etab;

  if (f.portee === 'etab' && !isInspector && !isSameEtab) {
    return res.status(403).send('Interdit');
  }
  res.download(f.path, f.originalName);
});

/* Delete (owner or insp) */
router.post('/:id/delete', isAuth, async (req, res) => {
  const f = await Fichier.findById(req.params.id);
  if (!f) return res.status(404).json({ error: 'Introuvable' });

  const owner = f.uploader?.id == req.session.user.id;
  const can   = owner || req.session.user.role === 'insp';
  if (!can) return res.status(403).json({ error: 'Interdit' });

  try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch (_) {}
  await Fichier.deleteOne({ _id:f._id });
  req.app.get('io')?.emit('files:changed', { deleted:String(f._id) });
  res.json({ ok:true });
});

/* Vue globale (IPR) */
router.get('/tous', isAuth, isInsp, async (req, res) => {
  const q = {};
  if (req.query.etablissement) q.etablissement = req.query.etablissement;
  if (req.query.specialite)    q.specialite    = req.query.specialite;
  if (req.query.categorie)     q.categorie     = req.query.categorie;
  if (req.query.evaluation)    q.evaluation    = Number(req.query.evaluation);

  const rowsRaw = await Fichier.find(q).sort('-createdAt').lean();
  const rows = rowsRaw.map(r => ({ ...r, url: publicUrl(r) }));
  res.render('fichier_liste', { user: req.session.user, rows });
});

module.exports = router;


