const express  = require('express');
const router   = express.Router();
const Collecte = require('../models/Collecte');
const { isAuth } = require('../middleware/authsuupr');

const getYear = () => {
  const d=new Date(), y=d.getFullYear(), m=d.getMonth();
  return (m>=7)? `${y}-${y+1}` : `${y-1}-${y}`;
};

router.use(isAuth);

// Nouvelle collecte (vue)
router.get('/nouvelle', (req,res)=>{
  res.render('collecte_form', { user:req.session.user }); // la vue lira user.inspection
});

// Mes collectes
router.get('/mes', async (req,res)=>{
  const u = req.session.user;
  const list = await Collecte
    .find({ animateur: u.nom, inspection: u.inspection })
    .sort({ dateDepot:-1 }).lean();
  res.render('collecte_mes', { user:u, list });
});

// Pré-remplissage cumul évaluations précédentes (accepte nom|discipline)
router.get('/prefill', async (req,res)=>{
  const u = req.session.user;
  const annee = req.query.annee || getYear();
  const { cycle, specialite, evaluation } = req.query;
  const evalNum = Number(evaluation||0);
  if(!cycle || !specialite || !evalNum) return res.json([]);

  const docs = await Collecte.find({
    inspection: u.inspection,
    etablissement: u.etab,
    annee, cycle, specialite,
    evaluation: { $lt: evalNum }
  }).lean();

  const acc = {};
  docs.forEach(doc=>{
    (doc.classes||[]).forEach(cl=>{
      const cn = cl.nom;
      (cl.disciplines||[]).forEach(d=>{
        const dn = String(d.nom || d.discipline || '').trim();
        if (!dn) return;
        const k = `${cn}||${dn}`;
        const o = acc[k] || (acc[k] = { classe:cn, discipline:dn, hF:0, lf:0, ldf:0, tf:0, tdf:0 });
        o.hF  += Number(d.hF||0);
        o.lf  += Number(d.lf||0);
        o.ldf += Number(d.ldf||0);
        o.tf  += Number(d.tf||0);
        o.tdf += Number(d.tdf||0);
      });
    });
  });
  res.json(Object.values(acc));
});

/* ===== Validation serveur : fait ≤ dû ===== */
function validateDueVsDone(payload){
  for (const c of (payload.classes||[])){
    for (const d of (c.disciplines||[])){
      const pairs = [
        ['hF','hD'],
        ['lf','lp'],
        ['ldf','ldp'],
        ['tf','tp'],
        ['tdf','tdp']
      ];
      for (const [doneKey, dueKey] of pairs){
        const done = Number(d[doneKey])||0;
        const due  = Number(d[dueKey])||0;
        if (done > due){
          throw new Error(`Valeur réalisée (${doneKey} ≤ ${dueKey}) dépasse le dû — classe "${c.nom}", discipline "${d.nom}"`);
        }
      }
    }
  }
}

// Création
router.post('/', async (req,res)=>{
  try{
    const B = req.body || {};
    const N = v => Number(v||0);

    const mapDisc = d => ({
      nom:String((d.nom || d.discipline || '').trim()),
      hD:N(d.hD), hF:N(d.hF),
      lp:N(d.lp), lf:N(d.lf), ldp:N(d.ldp), ldf:N(d.ldf),
      tp:N(d.tp), tf:N(d.tf), tdp:N(d.tdp), tdf:N(d.tdf),
      comp:N(d.comp), m10:N(d.m10), effTot:N(d.effTot), effPos:N(d.effPos)
    });

    const mapClasse = c => ({
      nom:String((c.nom||'').trim()),
      disciplines: Array.isArray(c.disciplines) ? c.disciplines.map(mapDisc).filter(x=>x.nom) : []
    });

    // index effectifs par classe (pour recopier dans classes[].filles/garcons)
    const effIndex = new Map(
      (Array.isArray(B.effectifs)?B.effectifs:[])
        .filter(e => (e.classe||'').trim())
        .map(e => [String(e.classe).trim().toLowerCase(), { filles:N(e.filles), garcons:N(e.garcons) }])
    );

    const effectifs = Array.isArray(B.effectifs) ? B.effectifs.map(e=>({
      classe:String((e.classe||'').trim()),
      filles:N(e.filles), garcons:N(e.garcons)
    })).filter(x=>x.classe) : [];

    const staff = Array.isArray(B.staff) ? B.staff.map(s=>({
      nom:String((s.nom||'').trim()),
      grade:String((s.grade||'').trim()),
      matiere:String((s.matiere||'').trim()),
      statut:String((s.statut||'').trim()),
      obs:String((s.obs||'').trim()),
      // ← conserve les affectations
      classes: Array.isArray(s.classes) ? s.classes.map(String) : [],
      disciplines: Array.isArray(s.disciplines) ? s.disciplines.map(String) : []
    })).filter(x=>x.nom) : [];

    const u = req.session.user;
    const draft = {
      inspection   : u.inspection || 'artsplastiques',
      departement  : u.departement || req.body.departement || '',
      annee        : String(B.annee || getYear()),
      cycle        : String(B.cycle||''),
      specialite   : String(B.specialite||''),
      evaluation   : Number(B.evaluation||0),
      etablissement: u.etab,
      animateur    : u.nom,
      classes      : Array.isArray(B.classes)
        ? B.classes.map(c => {
            const base = mapClasse(c);
            const key  = String(base.nom||'').trim().toLowerCase();
            const eff  = effIndex.get(key) || { filles:0, garcons:0 };
            return { ...base, filles: eff.filles, garcons: eff.garcons };
          }).filter(x=>x.disciplines.length)
        : [],
      effectifs,
      staff
    };

    validateDueVsDone(draft);
    const doc = await Collecte.create(draft);

    res.json({ message:'Fiche enregistrée', id: String(doc._id) });
  }catch(e){
    res.status(400).json({ error:e.message });
  }
});

// Suppression d'une collecte (AP propriétaire ou inspecteur)
router.delete('/:id', async (req,res)=>{
  const u = req.session.user;
  const id = req.params.id;
  const doc = await Collecte.findById(id);
  if(!doc) return res.status(404).json({ error:'collecte introuvable' });

  const isOwner = (doc.animateur===u.nom && doc.inspection===u.inspection);
  const isInspector = (u.role==='insp' || u.role==='inspecteur');
  if(!isOwner && !isInspector) return res.status(403).json({ error:'non autorisé' });

  await doc.deleteOne();
  res.json({ message:'Collecte supprimée' });
});

module.exports = router;
