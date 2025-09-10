// server/routes/fichiers.js
const path    = require('path');
const fs      = require('fs');
const express = require('express');
const multer  = require('multer');

const Upload  = require('../../models/Upload');

const router = express.Router();

/* === stockage multer (dossier /uploads) === */
const ROOT = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ROOT),
  filename: (_req, file, cb) => {
    const base = path.parse(file.originalname).name.replace(/[^\w\-. ]+/g, '_');
    const ext  = path.extname(file.originalname);
    cb(null, `${Date.now()}_${base}${ext}`); // nom unique
  }
});
const uploadMw = multer({ storage });

/* ===== helpers ===== */
function urlFor(p){                          // p ex: uploads/123.pdf  (ou chemin absolu)
  const rel = p.startsWith('uploads') ? p : path.relative(process.cwd(), p);
  return '/'+rel.replace(/\\/g,'/');        // servi par app.use('/uploads', …)
}
function sameInspection(a, b){
  return String(a||'').toLowerCase() === String(b||'').toLowerCase();
}
function canDeleteFile(fileDoc, user){
  if (!fileDoc || !user) return false;
  if (user.role === 'insp') {
    // Inspecteur : peut supprimer tout fichier de SA propre inspection
    return sameInspection(fileDoc.inspection, user.inspection);
  }
  // Autres rôles : seulement ses propres uploads
  return String(fileDoc.ownerId) === String(user.id);
}

/* ===== vues ===== */
router.get('/', (req, res) => {
  // backUrl optionnel: /fichiers?back=/inspector
  res.render('fichiers', { user: req.user, backUrl: req.query.back || '' });
});

/* ===== API ===== */

// Liste des fichiers visibles par l’inspection de l’utilisateur
router.get('/list-all', async (req, res, next) => {
  try{
    const insp = String(req.user?.inspection||'').toLowerCase();
    const q = { inspection: insp };

    // (facultatif) filtres supplémentaires
    if (req.query.etablissement) q.etablissement = String(req.query.etablissement);
    if (req.query.departement)   q.departement   = String(req.query.departement);
    if (req.query.annee)         q.annee         = String(req.query.annee);

    const files = await Upload.find(q).sort({ createdAt:-1 }).lean();

    const rows = files.map(f => ({
      id: String(f._id),
      name: f.name,
      size: f.size,
      createdAt: f.createdAt,
      url: urlFor(f.path), // sert via /uploads (protégé par requireAuth dans server.js)
      ownerId: String(f.ownerId||''),
      ownerName: f.ownerName || '',
      ownerRole: f.ownerRole || '',
      etablissement: f.etablissement || '',
      departement: f.departement || '',
      annee: f.annee || '',
      canDelete: canDeleteFile(f, req.user)
    }));

    res.json(rows);
  }catch(e){ next(e); }
});

// Upload (plusieurs fichiers)
router.post('/upload', uploadMw.array('files', 20), async (req, res, next) => {
  try{
    const user = req.user;
    const insp = String(user.inspection||'').toLowerCase();

    const docs = await Promise.all((req.files||[]).map(async f => {
      const doc = await Upload.create({
        name: f.originalname,
        size: f.size,
        path: path.relative(process.cwd(), f.path).replace(/\\/g,'/'),
        inspection: insp,
        etablissement: user.etab || '',
        departement : user.departement || '',
        annee       : req.body?.annee || '',
        ownerId: user.id,
        ownerName: user.nom,
        ownerRole: user.role
      });
      return {
        id: String(doc._id),
        name: doc.name,
        size: doc.size,
        url: urlFor(doc.path),
        createdAt: doc.createdAt,
        canDelete: true
      };
    }));

    res.json({ files: docs });
  }catch(e){ next(e); }
});

// Téléchargement sécurisé par ID (ne dévoile pas le chemin disque)
router.get('/download/:id', async (req, res, next) => {
  try{
    const id = req.params.id;
    const doc = await Upload.findById(id).lean();
    if (!doc) return res.status(404).json({ error:'not found' });

    // Accès restreint à la même inspection (partage insp/anim)
    const user = req.user;
    if (!user || !sameInspection(doc.inspection, user.inspection)) {
      return res.status(403).json({ error:'forbidden' });
    }

    // Résolution du chemin physique en s’assurant qu’il reste dans /uploads
    const abs = path.resolve(process.cwd(), doc.path);
    if (!abs.startsWith(ROOT)) {
      return res.status(400).json({ error:'path invalid' });
    }

    // Fichier présent ?
    try{
      await fs.promises.access(abs, fs.constants.R_OK);
    }catch{
      return res.status(404).json({ error:'file missing' });
    }

    // Téléchargement avec un nom propre (doc.name)
    return res.download(abs, doc.name);
  }catch(e){ next(e); }
});

// Suppression par ID (contrôle d’accès strict)
router.post('/:id/delete', async (req, res, next) => {
  try{
    const id = req.params.id;
    const doc = await Upload.findById(id);
    if (!doc) return res.status(404).json({ error:'not found' });

    if (!canDeleteFile(doc, req.user)) {
      if (req.accepts('html')) return res.status(403).send('forbidden');
      return res.status(403).json({ error: 'forbidden' });
    }

    // supprime le fichier physique si présent
    const abs = path.join(process.cwd(), doc.path);
    try{ await fs.promises.rm(abs, { force:true }); }catch(_){/* ignore */ }

    await Upload.deleteOne({ _id: id });

    // si l’appel vient du formulaire, on redirige sur la page des fichiers
    if (req.accepts('html')) return res.redirect('/fichiers');
    res.json({ ok:true });
  }catch(e){ next(e); }
});

module.exports = router;
