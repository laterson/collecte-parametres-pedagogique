const express = require('express');
const router  = express.Router();
const { requireAuth } = require('../server/middleware/auth');
const Collecte = require('../models/Collecte');

router.use(requireAuth);

// GET /collecte/inspecteur/depots/:id
router.get('/depots/:id', async (req,res)=>{
  const id = req.params.id;
  const doc = await Collecte.findById(id).lean();
  if(!doc || (doc.inspection !== req.user.inspection)){
    return res.status(404).send('Dépôt introuvable');
  }

  // Totaux par classe + par discipline (format attendu par la table)
  const MAP = { hD:'Hd', hF:'Hf', lp:'Lp', lf:'Lf', ldp:'Ldp', ldf:'Ldf',
                tp:'Tp', tf:'Tf', tdp:'Tdp', tdf:'Tdf', comp:'Comp', m10:'M10', effTot:'EffT', effPos:'EffP' };
  const KEYS = Object.values(MAP);
  function add(total, d){ for(const [src,dst] of Object.entries(MAP)) total[dst]=(total[dst]||0)+(Number(d[src])||0); }
  const classes = (doc.classes||[]).map(c=>{
    const total = Object.fromEntries(KEYS.map(k=>[k,0]));
    (c.disciplines||[]).forEach(d=> add(total,d));
    return { nom:c.nom, filles:Number(c.filles||0), garcons:Number(c.garcons||0), disciplines:c.disciplines, total };
  });

  res.render('collecte_detail', { user:req.user, doc, classes, staff: doc.staff || [] });
});

module.exports = router;
