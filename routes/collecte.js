const express  = require('express');
const router   = express.Router();
const Collecte = require('../models/Collecte');
const { isAuth } = require('../middleware/authsuupr');

const getYear = () => {
  const d=new Date(), y=d.getFullYear(), m=d.getMonth();
  return (m>=7)? `${y}-${y+1}` : `${y-1}-${y}`;
};

router.use(isAuth);

// --- VUES ---
router.get('/nouvelle', (req,res)=>{
  res.render('collecte_form', { user:req.session.user });
});

router.get('/mes', async (req,res)=>{
  const u = req.session.user;
  const list = await Collecte
    .find({ animateur: u.nom, inspection: u.inspection })
    .sort({ dateDepot:-1 }).lean();
  res.render('collecte_mes', { user:u, list });
});


// --- API ---

// PRÉ-REMPLISSAGE : Renvoie les données EXACTES de l'évaluation précédente (N-1)
router.get('/prefill', async (req,res)=>{
  try {
    const u = req.session.user;
    const annee = req.query.annee || getYear();
    const { cycle, specialite, evaluation } = req.query;
    
    const evalNumActuelle = Number(evaluation || 0);
    if(!cycle || !specialite || !evalNumActuelle || evalNumActuelle < 2) {
      return res.json([]);
    }

    const evalNumPrecedente = evalNumActuelle - 1;

    const docPrecedent = await Collecte.findOne({
      inspection: u.inspection,
      etablissement: u.etab,
      annee,
      cycle,
      specialite,
      evaluation: evalNumPrecedente
    }).lean();

    if (!docPrecedent || !docPrecedent.classes || docPrecedent.classes.length === 0) {
      return res.json([]);
    }

    // On met les données dans le format plat attendu par le frontend
    const resultat = [];
    (docPrecedent.classes || []).forEach(classe => { // "classe" ici est une division
      (classe.disciplines || []).forEach(discipline => {
        resultat.push({
          classe: classe.nom, // Nom complet avec division, ex: "1ère Année DECO (2)"
          discipline: discipline.nom,
          heuresFaites: discipline.hF,
          leconsFaites: discipline.lf,
          leconsDigFaites: discipline.ldf,
          tpFaits: discipline.tf,
          tpDigFaits: discipline.tdf,
          elevesComposants: discipline.comp,
          elevesMoySup10: discipline.m10,
          effPos: discipline.effPos
        });
      });
    });

    res.json(resultat);

  } catch (error) {
    console.error("Erreur dans /prefill:", error);
    res.status(500).json({ error: "Erreur serveur lors du préremplissage." });
  }
});

// CRÉATION / SOUMISSION d'une collecte
router.post('/', async (req,res)=>{
  try{
    const B = req.body || {};
    const u = req.session.user;
    const N = v => Number(v||0);

    // Le payload est nettoyé et validé, mais la structure par division est CONSERVÉE
    const draft = {
      inspection: u.inspection,
      departement: u.departement,
      annee: String(B.annee || getYear()),
      cycle: String(B.cycle||''),
      specialite: String(B.specialite||''),
      evaluation: N(B.evaluation),
      etablissement: u.etab,
      animateur: u.nom,
      classes: Array.isArray(B.classes) ? B.classes.map(c => ({
        nom: String(c.nom || '').trim(),
        disciplines: Array.isArray(c.disciplines) ? c.disciplines.map(d => ({
          nom: String(d.nom || '').trim(),
          hD:N(d.hD), hF:N(d.hF), lp:N(d.lp), lf:N(d.lf), ldp:N(d.ldp), ldf:N(d.ldf),
          tp:N(d.tp), tf:N(d.tf), tdp:N(d.tdp), tdf:N(d.tdf),
          comp:N(d.comp), m10:N(d.m10), effTot:N(d.effTot), effPos:N(d.effPos)
        })).filter(d => d.nom) : []
      })).filter(c => c.nom && c.disciplines.length > 0) : [],
      effectifs: Array.isArray(B.effectifs) ? B.effectifs : [],
      staff: Array.isArray(B.staff) ? B.staff : []
    };

    if (draft.evaluation === 0) throw new Error("Le numéro d'évaluation est manquant.");

    // Cette version détaillée est sauvegardée, ce qui est crucial pour le pré-remplissage.
    const doc = await Collecte.create(draft);

    // TODO (optionnel): Ici, le backend peut faire la compilation et la sauvegarder
    // dans une autre collection pour l'inspecteur.

    res.json({ message:'Fiche enregistrée', id: String(doc._id) });

  }catch(e){
    console.error("Erreur dans POST /collecte:", e);
    res.status(400).json({ error: e.message });
  }
});

// SUPPRESSION d'une collecte
router.delete('/:id', async (req,res)=>{
  const u = req.session.user;
  const id = req.params.id;
  const doc = await Collecte.findById(id);
  if(!doc) return res.status(404).json({ error:'Collecte introuvable' });

  const isOwner = (doc.animateur===u.nom && doc.inspection===u.inspection);
  const isInspector = (u.role==='insp' || u.role==='inspecteur');
  if(!isOwner && !isInspector) return res.status(403).json({ error:'Non autorisé' });

  await doc.deleteOne();
  res.json({ message:'Collecte supprimée' });
});

module.exports = router;