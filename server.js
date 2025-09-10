/* ─────────────── server.js ─────────────── */
require('dotenv').config();

const path           = require('path');
const fs             = require('fs');
const http           = require('http');
const express        = require('express');
const mongoose       = require('mongoose');
const cors           = require('cors');
const session        = require('express-session');
const SchoolCard = require('./models/SchoolCard');
const MongoStore     = require('connect-mongo');
const bcrypt         = require('bcrypt');
const methodOverride = require('method-override');
const carteRoutes = require('./server/routes/carte');
/* Sécurité & logs */
const helmet         = require('helmet');
const morgan         = require('morgan');
const rateLimit      = require('express-rate-limit');

/* Models */
const User       = require('./models/User');
const Collecte   = require('./models/Collecte');
const Message    = require('./models/Message');
const Catalog    = require('./models/DisciplineCatalog');
const SpecPreset = require('./models/SpecPreset');
const Settings   = require('./models/Settings');
const Baseline   = require('./models/Baseline');
const Teacher = require('./models/Teacher'); // <- pour s'assurer du chargement du modèle
/* Middlewares & routes sécurisées */
const { limitToInspection, limitAnimToOwnEtab } = require('./server/middleware/scope');
const { attachUser, requireAuth, requireRole, regenerateSession } = require('./server/middleware/auth');
const fichiersRouter = require('./server/routes/fichiers');
const adminRouter    = require('./server/routes/admin');
const inspecteurApiRouter = require('./server/routes/inspecteur');

/* ===== Seed admin (1er démarrage) ===== */
async function seedAdmin(){
  if (await User.exists({ role:'admin' })) { console.log('✅ Admin ok'); return; }
  const { ADMIN_EMAIL='admin@test.com', ADMIN_PASSWORD='Admin123!' } = process.env;
  const hash = await bcrypt.hash(ADMIN_PASSWORD,12);
  await User.create({
    nomComplet   : 'Super Administrateur',
    email        : ADMIN_EMAIL,
    etablissement: 'Direction Régionale',
    role         : 'admin',
    inspection   : 'artsplastiques',
    passwordHash : hash
  });
  console.log(`🎉 Admin → ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
}

/* ===== Référentiels statiques (fallback V1) ===== */
const CLASSES_BY_SPEC = {
  DECO: ['1ère année DECO','2ème année DECO','3ème année DECO','4ème année DECO'],
  AF1 : ['2nde AF1','1ère AF1','Tle AF1'],
  AF2 : ['2nde AF2','1ère AF2','Tle AF2'],
  AF3 : ['2nde AF3','1ère AF3','Tle AF3']
};
const EXPECTED_BY_SPEC = {
  DECO: ['Dessin technique','Décoration modelée',"Histoire de l'art",'Technologie des matériaux','Outillage','Dessin de décor'],
  AF1 : ['Technologie des matériaux',"Histoire de l'art",'Anatomie artistique','Atelier AF1','Dessin géométrique',"Dessin d’après nature"],
  AF2 : ['Technologie des matériaux',"Histoire de l'art",'Atelier AF2','Peinture sur toile','Couleur et perspective',"Dessin d’après nature"],
  AF3 : ['Technologie des matériaux',"Histoire de l'art",'Atelier AF3','Sculpture sur bois','Modelage','Croquis de sculpture']
};

/* ===== Helpers agrégations ===== */
const TRI  = { T1:[1,2], T2:[3,4], T3:[5,6] };
const pct  = (den,num)=> den ? Number(((num/den)*100).toFixed(2)) : 0;
const norm = s => String(s ?? '').trim();
const normStrict = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,'').trim();

function emptyTotals(){
  return { Hd:0,Hf:0, Lp:0,Lf:0, Ldp:0,Ldf:0, Tp:0,Tf:0, Tdp:0,Tdf:0, Comp:0,M10:0, EffT:0,EffP:0 };
}
const n = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim()!=='') return Number(v) || 0;
  }
  return 0;
};
function addTotals(T, d){
  T.Hd  += n(d,'hD','Hd','hd','heuresDues');
  T.Hf  += n(d,'hF','Hf','hf','heuresFaites');
  T.Lp  += n(d,'lp','Lp','leconsPrevues');
  T.Lf  += n(d,'lf','Lf','leconsFaites');
  T.Ldp += n(d,'ldp','Ldp','leconsDigPrevues','leconsDigitaliseesPrevues');
  T.Ldf += n(d,'ldf','Ldf','leconsDigFaites','leconsDigitaliseesFaites');
  T.Tp  += n(d,'tp','Tp','tpPrevus');
  T.Tf  += n(d,'tf','Tf','tpFaits');
  T.Tdp += n(d,'tdp','Tdp','tpDigPrevus','tpDigitalisesPrevus');
  T.Tdf += n(d,'tdf','Tdf','tpDigFaits','tpDigitalisesFaits');
  T.Comp+= n(d,'comp','Comp','elevesComposes');
  T.M10 += n(d,'m10','M10','elevesMoySup10');
  T.EffT+= n(d,'effTot','EffT','ensTot','enseignantsTotaux');
  T.EffP+= n(d,'effPos','EffP','ensPoste','enseignantsEnPoste');
}
function packTotals(T){
  const out = {
    Hd:T.Hd, Hf:T.Hf, Lp:T.Lp, Lf:T.Lf, Ldp:T.Ldp, Ldf:T.Ldf,
    Tp:T.Tp, Tf:T.Tf, Tdp:T.Tdp, Tdf:T.Tdf, Comp:T.Comp, M10:T.M10, EffT:T.EffT, EffP:T.EffP,
    H_pct : pct(T.Hd,T.Hf),
    L_pct : pct(T.Lp,T.Lf),
    Ld_pct: pct(T.Ldp,T.Ldf),
    Tp_pct: pct(T.Tp,T.Tf),
    Td_pct: pct(T.Tdp,T.Tdf),
    R_pct : pct(T.Comp,T.M10),
    A_pct : pct(T.EffT,T.EffP),
  };
  out.H = out.H_pct; out.Pc = out.L_pct; out.Pd = out.Ld_pct;
  out.Tc = out.Tp_pct; out.Td = out.Td_pct; out.R = out.R_pct; out.A = out.A_pct;
  return out;
}
const getDiscs = (c)=> Array.isArray(c?.disciplines) ? c.disciplines : (Array.isArray(c?.modules) ? c.modules : []);

// ++ Helpers effectifs par genre (classe ET discipline, alias tolérés)
const pick = (o, ...keys) => keys.reduce((s,k)=> s + (Number(o?.[k] ?? 0) || 0), 0);
function addGenderFromClass(T, c){
  T.filles  = (T.filles  || 0) + pick(c, 'filles','Filles','fille','F','f');
  T.garcons = (T.garcons || 0) + pick(c, 'garcons','Garcons','garçon','G','g');
}
function addGenderFromDisc(T, d){
  T.filles  = (T.filles  || 0) + pick(d, 'filles','Filles','F','f');
  T.garcons = (T.garcons || 0) + pick(d, 'garcons','Garcons','G','g');
}

/* ===== Vue formulaire agrégée ===== */
function buildFormViewForClass(fiches, expectedList, classeName){
  const expected      = Array.isArray(expectedList) ? expectedList : [];
  const expectedOrder = new Map(expected.map((n,i)=>[n,i]));
  const perDisc = {};
  const etabsInClass = new Set();
  const countByDisc  = {};

  const wanted = normStrict(classeName);

  for (const F of fiches){
    const cl = (F.classes||[]).find(c => normStrict(c.nom)===wanted);
    if(!cl) continue;
    etabsInClass.add(F.etablissement||'—');
    getDiscs(cl).forEach(d=>{
      const key = norm(d.discipline ?? d.nom ?? d.name);
      const T = (perDisc[key] ||= emptyTotals());
      addTotals(T, d);
      countByDisc[key] = (countByDisc[key]||0) + 1;
    });
  }

  const present  = Object.keys(perDisc);
  const allNames = new Set([...expected, ...present]);
  const rows = [];
  const totalClass = emptyTotals();

  for (const name of allNames){
    const isExpected = expected.includes(name);
    const T = perDisc[name] || emptyTotals();
    const packed = packTotals(T);
    rows.push({
      nom:name, occurrences: countByDisc[name]||0,
      expected:isExpected, foreign: !isExpected && (countByDisc[name]||0)>0, missing: isExpected && !(countByDisc[name]||0),
      ...packed
    });
    addTotals(totalClass, T);
  }

  rows.sort((a,b)=>{
    const aIdx = expectedOrder.has(a.nom) ? expectedOrder.get(a.nom) : 1e9;
    const bIdx = expectedOrder.has(b.nom) ? expectedOrder.get(b.nom) : 1e9;
    if (aIdx!==bIdx) return aIdx-bIdx;
    return a.nom.localeCompare(b.nom);
  });

  return { classe: classeName, etablissements: etabsInClass.size, disciplines: rows, total: packTotals(totalClass), expected };
}

/* ===== Vue AP (baselines) ===== */
async function buildAPForm({ inspection, etablissement, annee, cycle, specialite }) {
  const SPEC = String(specialite).toUpperCase();
  const S = await Settings.findOne({ inspection, etablissement, annee }).lean();
  let classes = [];
  if (Array.isArray(S?.effectifs) && S.effectifs.length) {
    classes = [...new Set(S.effectifs.map(e => String(e.classe||'').trim()).filter(Boolean))];
  }
  if (!classes.length) {
    const preset = await SpecPreset.findOne({ inspection, cycle, specialite:SPEC }).lean();
    classes = preset?.classes || (CLASSES_BY_SPEC[SPEC] || []);
  }

  const discs = await Catalog.find({ inspection, cycle, specialite:SPEC, actif:true }).sort({ ordre:1, nom:1 }).lean();
  const expected = discs.length ? discs.map(d=>d.nom) : (EXPECTED_BY_SPEC[SPEC] || []);

  const B = await Baseline.find({ etablissement, annee, cycle, specialite:SPEC }).lean();
  const key = (c,d)=> `${norm(c)}::${norm(d)}`;
  const bMap = new Map();
  for (const b of B) {
    const normB = {
      heuresDues        : Number(b.heuresDues        ?? b.Hd        ?? 0),
      leconsPrevues     : Number(b.leconsPrevues     ?? b.Lp        ?? 0),
      leconsDigPrevues  : Number(b.leconsDigPrevues  ?? b.Ldp       ?? 0),
      tpPrevus          : Number(b.tpPrevus          ?? b.Tp        ?? 0),
      tpDigPrevus       : Number(b.tpDigPrevus       ?? b.Tdp       ?? 0),
      enseignantsPoste  : Number(b.enseignantsPoste  ?? b.ensPoste  ?? 0),
    };
    bMap.set(key(b.classe,b.discipline), normB);
  }

  const classesOut = classes.map(cl => ({
    classe: cl,
    disciplines: expected.map(name => {
      const b = bMap.get(key(cl,name)) || {};
      return {
        discipline: name,
        hD : Number(b.heuresDues)||0,
        lp : Number(b.leconsPrevues)||0,
        ldp: Number(b.leconsDigPrevues)||0,
        tp : Number(b.tpPrevus)||0,
        tdp: Number(b.tpDigPrevus)||0,
        effTot: Number(b.enseignantsPoste)||0,
        hF:0, lf:0, ldf:0, tf:0, tdf:0, comp:0, m10:0, effPos:0
      };
    })
  }));

  return { classes: classesOut, expected };
}

/* ======================= Bootstrap ======================= */
(async ()=>{
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fiches';
  mongoose.set('strictQuery', false);
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB connecté');
  await seedAdmin();

  const app    = express();
  const server = http.createServer(app);
  app.set('trust proxy', 1);

  /* Sessions (partagées avec socket.io) */
   const isProd = process.env.NODE_ENV === 'production';

const sessionMiddleware = session({
  secret : process.env.SESSION_SECRET || 'ChangeMe',
  resave : false,
  saveUninitialized: false,
  store  : MongoStore.create({ mongoUrl: MONGODB_URI }),
  cookie : {
    maxAge  : 1000 * 60 * 60 * 2, // 2h
    sameSite: 'lax',
    httpOnly: true,
    secure  : isProd
  }
});
  /* Vues & statiques */
  app.set('view engine','ejs');
  app.set('views', path.join(__dirname,'views'));
  const pub1 = path.join(__dirname,'Public');
  const pub2 = path.join(__dirname,'public');
  if (fs.existsSync(pub1)) app.use(express.static(pub1));
  if (fs.existsSync(pub2)) app.use(express.static(pub2));

  /* Middlewares globaux */
  app.use(helmet({ contentSecurityPolicy:false }));
  app.use(morgan('tiny'));
  app.use(rateLimit({ windowMs: 15*60*1000, max: 300, standardHeaders:true, legacyHeaders:false }));
  app.use(cors({ origin:true, credentials:true }));
  app.use(express.json({ limit:'10mb' }));
  app.use(express.urlencoded({ extended:false }));
  app.use(methodOverride('_method'));
  app.use(sessionMiddleware);

  /* 🔐 user en session → req.user */
  app.use(attachUser);
  app.use('/api', requireAuth, limitToInspection(), limitAnimToOwnEtab());

  /* Helpers */
  app.get('/healthz', (_req,res)=> res.json({ ok:true, ts:Date.now() }));

  const isAuth  = (req,res,next)=> req.user ? next() : res.redirect('/login');
  const isAdmin = requireRole('admin');
  const isInsp  = requireRole('insp');

  const withInsp = (req,_res,next)=>{ req.insp = (req.user?.inspection || 'artsplastiques').toLowerCase(); next(); };

  /* Fichiers uploadés protégés */
  /* Fichiers uploadés protégés */
  {
    const uploadsRoot = path.join(process.cwd(), 'uploads');
    const staticOpts = {
      fallthrough: false,
      dotfiles: 'ignore',
      etag: true,
      maxAge: '5m',
      setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=300');
      }
    };

    // Protégé par session + scope inspection
    app.use(
      '/uploads',
      requireAuth,
      limitToInspection(),
      express.static(uploadsRoot, staticOpts)
    );
  }


  /* ===== Auth ===== */
  app.get('/login',(req,res)=> {
    const role = ['admin','anim','insp'].includes(req.query.role) ? req.query.role : 'anim';
    res.render('login',{ error:null, role });
  });

  app.post('/auth/register', isAuth, isAdmin, async (req,res)=>{
    const { nomComplet, email, password, etablissement, role='anim', inspection='artsplastiques' } = req.body;
    if(!email||!password) return res.status(400).json({ error:'email & pass requis' });
    const hash = await bcrypt.hash(password,12);
    const u = await User.create({ nomComplet, email, etablissement, role, inspection, passwordHash:hash });
    res.json({ message:'OK', id:u._id });
  });

  app.post('/auth/login', async (req,res)=>{
  const { email, password, role='anim' } = req.body;
  const user = await User.findOne({ email });
  if(!user || user.role!==role || !(await user.verifyPassword(password))){
    return res.status(401).render('login',{ error:'Identifiants invalides', role });
  }
  await regenerateSession(req);
  req.session.user = {
    id         : user._id,
    nom        : user.nomComplet,
    etab       : user.etablissement,
    etabId     : user.etablissementId || null,
    departement: user.departement || '',
    departementCode: user.departementCode || '',
    role       : user.role,
    inspection : user.inspection || 'artsplastiques',
    specialite : user.specialite || ''
  };
   // 👇 Ajoute cette ligne pour vérifier ce qui est stocké
  console.log('Session user après login:', req.session.user);
  res.redirect('/');
});


  app.post('/auth/logout',(req,res)=> req.session.destroy(()=>res.redirect('/login')));

  /* ===== Admin & Inspecteur ===== */
  app.get('/admin', isAuth, isAdmin, (req,res)=> res.render('admin',{ user:req.user }));
  app.get('/inspector', isAuth, isInsp, (req,res)=> res.render('inspector',{ user:req.user }));
  app.get('/inspector/carte', isAuth, isInsp, (req,res)=> res.render('inspector_carte',{ user:req.user }));

  /* Monte l’API Admin */
  app.use('/admin', requireAuth, isAdmin, adminRouter);
  app.use('/api/inspecteur', requireAuth, limitToInspection(), inspecteurApiRouter);
  


  /* ===== APIs de synthèse ===== */
  app.get('/api/summary/list', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, etablissement, departement } = req.query;
  if(!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

  const f = { inspection:req.insp, cycle:String(cycle), specialite:String(specialite).toUpperCase() };
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 filtres additionnels
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const fiches = await Collecte.find(f).sort('etablissement');
  const out = fiches.map(F=>{
    const T = emptyTotals();
    (F.classes||[]).forEach(c=> getDiscs(c).forEach(d=> addTotals(T,d)));
    const P = packTotals(T);
    return { etablissement:F.etablissement, animateur:F.animateur, evaluation:F.evaluation,
             H:P.H, Pc:P.Pc, Pd:P.Pd, Tc:P.Tc, Td:P.Td, R:P.R, A:P.A };
  });
  res.json(out);
});


  app.get('/api/summary/by-etab', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, etablissement, departement } = req.query;
  if(!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

  const f = { inspection:req.insp, cycle:String(cycle), specialite:String(specialite).toUpperCase() };
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 filtres supplémentaires (optionnels)
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

    const fiches = await Collecte.find(f).lean();
    const byE = {};
    for (const F of fiches) {
      const key = F.etablissement || '—';
      const T = (byE[key] ||= {
        etablissement:key, animateurs:new Set(), evals:new Set(),
        classes:0, disc:0, ...emptyTotals()
      });
      T.animateurs.add(F.animateur);
      T.evals.add(F.evaluation);
      (F.classes||[]).forEach(c=>{
        T.classes++;
        getDiscs(c).forEach(d=>{ T.disc++; addTotals(T,d); });
      });
    }
    const rows = Object.values(byE).map(T=>({
      etablissement:T.etablissement,
      animateurs:Array.from(T.animateurs).length,
      evaluations:Array.from(T.evals).sort((a,b)=>a-b).join(','),
      classes:T.classes, disciplines:T.disc, ...packTotals(T),
    })).sort((a,b)=> a.etablissement.localeCompare(b.etablissement));
    res.json(rows);
  });

app.get('/api/summary/by-class', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, etablissement, departement } = req.query;
  if(!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

  const f = { inspection:req.insp, cycle:String(cycle), specialite:String(specialite).toUpperCase() };
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 filtres additionnels
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const fiches = await Collecte.find(f).lean();
  const agg = {};
  fiches.forEach(F=>{
    (F.classes||[]).forEach(c=>{
      const key = c.nom || '—';
      const T = (agg[key] ||= { n:0, ...emptyTotals() });
      getDiscs(c).forEach(d=> addTotals(T,d));
      T.n++;
    });
  });
  const rows = Object.entries(agg).map(([classe,T])=>({ classe, occurrences:T.n, ...packTotals(T) }))
    .sort((a,b)=> a.classe.localeCompare(b.classe));
  res.json(rows);
});


  /* ========= formulaire inspecteur (vue "form-view") ========= */
app.get('/api/summary/form-view', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, classe, etablissement, departement } = req.query;
  if(!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

  const SPEC = String(specialite).toUpperCase();
  const f = { inspection:req.insp, cycle:String(cycle), specialite:SPEC };
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 filtres additionnels
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const fiches = await Collecte.find(f).lean();

  const discs = await Catalog.find({ inspection:req.insp, cycle:String(cycle), specialite:SPEC, actif:true })
    .sort({ ordre:1, nom:1 }).lean();
  const expected = (discs.length ? discs.map(d=>d.nom) : (EXPECTED_BY_SPEC[SPEC] || []));

  const discovered = new Set();
  for (const F of fiches) (F.classes||[]).forEach(c=>{
    const name = String(c.nom||'').trim();
    if (name) discovered.add(name);
  });

  let classNames = Array.from(discovered).sort((a,b)=> a.localeCompare(b));
  if (!classNames.length) {
    const preset = await SpecPreset.findOne({ inspection:req.insp, cycle:String(cycle), specialite:SPEC }).lean();
    classNames = (preset?.classes?.length ? preset.classes : (CLASSES_BY_SPEC[SPEC] || []));
  }

  const build = (name)=> buildFormViewForClass(fiches, expected, name);
  if (classe) return res.json(build(classe));
  res.json(classNames.map(build));
});


  // === AP: vue formulaire avec baselines (priorité Effectifs) ===
  app.get('/api/collecte/form-ap', isAuth, withInsp, async (req,res,next)=>{
    try{
      const u = req.user;
      const { annee, cycle, specialite } = req.query;
      if(!annee || !cycle || !specialite) return res.status(400).json({ error:'annee, cycle, specialite requis' });
      const data = await buildAPForm({ inspection: req.insp, etablissement: u.etab, annee, cycle, specialite });
      res.json(data);
    }catch(e){ next(e); }
  });

  /* Divers tableaux de bord */
 app.get('/api/summary/risk', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, metric='L_pct', threshold='60', etablissement, departement } = req.query;
  if(!cycle || !specialite) return res.status(400).json({ error:'cycle & specialite requis' });

  const f = { inspection:req.insp, cycle:String(cycle), specialite:String(specialite).toUpperCase() };
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 filtres additionnels
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const fiches = await Collecte.find(f).lean();
  const byE = {};
  for (const F of fiches){
    const key = F.etablissement || '—';
    const T = (byE[key] ||= { etablissement:key, ...emptyTotals() });
    (F.classes||[]).forEach(c=> getDiscs(c).forEach(d=> addTotals(T,d)));
  }
  const rows = Object.values(byE).map(T=> ({ etablissement:T.etablissement, ...packTotals(T) }));
  const thr = Number(threshold)||0;
  const filtered = rows.filter(r => (r[metric]??100) < thr).sort((a,b)=> (a[metric]??0) - (b[metric]??0));
  res.json({ metric, threshold:thr, rows:filtered });
});


  app.get('/api/summary/global', isAuth, isInsp, withInsp, async (req,res)=>{
  const { etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  // 👇 globale → on accepte aussi un ciblage si fourni
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const fiches = await Collecte.find(f).lean();
  const byEval = {1:[],2:[],3:[],4:[],5:[],6:[]};
  fiches.forEach(F=> byEval[F.evaluation]?.push(F));

  function collect(list){
    const T = emptyTotals();
    list.forEach(F=> (F.classes||[]).forEach(c=> getDiscs(c).forEach(d=> addTotals(T,d))));
    return packTotals(T);
  }

  const evalRows = [1,2,3,4,5,6].map(k=> ({ label:`Éval ${k}`, ...collect(byEval[k]) }));
  const triRows  = [
    {label:'T1 (1+2)', ...collect([...(byEval[1]||[]), ...(byEval[2]||[])])},
    {label:'T2 (3+4)', ...collect([...(byEval[3]||[]), ...(byEval[4]||[])])},
    {label:'T3 (5+6)', ...collect([...(byEval[5]||[]), ...(byEval[6]||[])])},
  ];
  const annRows  = [{ label:'Annuel', ...collect(fiches) }];
  res.json({ eval:evalRows, tri:triRows, ann:annRows });
});


  /* ======== NOUVELLES ROUTES ======== */
// Routes AP (saisie effectifs & personnel)
app.use('/api/ap', requireAuth, require('./routes/ap'));
  // 1) Explorateur “région”
  app.get('/api/summary/topology', isAuth, isInsp, withInsp, async (req,res)=>{
    const { annee, evaluation, trimestre } = req.query;
    const f = { inspection:req.insp };
    if (annee)      f.annee = String(annee);
    if (evaluation) f.evaluation = Number(evaluation);
    else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

    const fiches = await Collecte.find(f).select('cycle specialite classes.nom').lean();
    const byCycle = new Map();
    for (const F of fiches){
      const cycle = String(F.cycle);
      const spec  = String(F.specialite||'').toUpperCase();
      const classes = (F.classes||[]).map(c=> String(c.nom||'').trim()).filter(Boolean);
      if (!byCycle.has(cycle)) byCycle.set(cycle, new Map());
      const mapSpec = byCycle.get(cycle);
      if (!mapSpec.has(spec)) mapSpec.set(spec, new Set());
      const setClasses = mapSpec.get(spec);
      classes.forEach(c=> setClasses.add(c));
    }
    const cycles = Array.from(byCycle.entries()).map(([cycle, specs])=>({
      key:cycle, label: cycle==='premier' ? 'Premier' : 'Second',
      specialites: Array.from(specs.entries()).map(([spec,setC])=>({ key:spec, label:spec, classes: Array.from(setC).sort() }))
        .sort((a,b)=> a.key.localeCompare(b.key))
    })).sort((a,b)=> a.key.localeCompare(b.key));

    res.json({ cycles });
  });

  // 2) KPI
 app.get('/api/summary/kpis', isAuth, isInsp, withInsp, async (req,res)=>{
  const { annee, cycle, specialite, classe, evaluation, trimestre, etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 ciblage fin côté inspecteur
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

    const fiches = await Collecte.find(f).lean();

    const estab = new Set();
    const anims = new Set();
    let depots = 0;
    const T = emptyTotals();

    for (const F of fiches){
      depots += 1;
      estab.add(F.etablissement||'—');
      if (F.animateur) anims.add(F.animateur);
      (F.classes||[]).forEach(c=>{
        if (classe && normStrict(c.nom) !== normStrict(classe)) return;
        getDiscs(c).forEach(d=> addTotals(T,d));
      });
    }

    const P = packTotals(T);
    res.json({
      etablissements: estab.size,
      apActifs: anims.size,
      depots,
      effectifsRegion: { enseignantsTotaux: T.EffT, enseignantsEnPoste: T.EffP, eleves: T.Comp },
      taux: {
        couvertureHeures: P.H, leconsFaites: P.Pc, leconsDigitalFaites: P.Pd,
        tpFaits: P.Tc, tpDigitalFaits: P.Td, reussite: P.R
      }
    });
  });

  // 3) Carte scolaire régionale (enrichie)
  app.get('/api/summary/school-map', isAuth, isInsp, withInsp, async (req,res)=>{
  const { annee, evaluation, trimestre, cycle, specialite, etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 filtres régionaux précis
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;


    const fiches = await Collecte.find(f).lean();

    const byE = new Map();
    const regionTotals = { etabs:0, ap:new Set(), EfT:0, EfP:0, filles:0, garcons:0, eleves:0, classes:new Set() };

    for (const F of fiches){
      const key = F.etablissement || '—';
      if (!byE.has(key)) byE.set(key, {
        etablissement:key,
        cycles:new Set(),
        classesOuvertes:new Set(),
        ap:new Set(),
        apNoms:new Set(),
        EfT:0, EfP:0, filles:0, garcons:0, Comp:0
      });
      const r = byE.get(key);

      r.cycles.add(F.cycle);
      if (F.animateur){ r.ap.add(F.animateur); r.apNoms.add(F.animateur); regionTotals.ap.add(F.animateur); }

      (F.classes || []).forEach(c=>{
        const cname = String(c.nom||'').trim();
        if (cname){ r.classesOuvertes.add(cname); regionTotals.classes.add(cname); }

        // effectifs par genre au niveau classe (si fournis)
        addGenderFromClass(r, c);
        regionTotals.filles  += pick(c,'filles','Filles','F','f');
        regionTotals.garcons += pick(c,'garcons','Garcons','G','g');

        getDiscs(c).forEach(d=>{
          // enseignants
          r.EfT += n(d, 'effTot', 'EffT', 'ensTot');
          r.EfP += n(d, 'effPos', 'EffP', 'ensPoste');
          regionTotals.EfT += n(d, 'effTot', 'EffT', 'ensTot');
          regionTotals.EfP += n(d, 'effPos', 'EffP', 'ensPoste');

          // élèves (composition globale si déclarée côté discipline)
          const comp = n(d, 'comp', 'Comp');
          r.Comp += comp; regionTotals.eleves += comp;

          // genre au niveau discipline (fallback)
          addGenderFromDisc(r, d);
          regionTotals.filles  += pick(d,'filles','Filles','F','f');
          regionTotals.garcons += pick(d,'garcons','Garcons','G','g');
        });
      });
    }

    const rows = Array.from(byE.values()).map(r=>({
      etablissement       : r.etablissement,
      cyclesOuverts       : Array.from(r.cycles).sort(),
      classesOuvertes     : Array.from(r.classesOuvertes).sort(),
      apList              : Array.from(r.apNoms).sort(),
      apActifs            : r.ap.size,
      enseignantsTotaux   : r.EfT,
      enseignantsEnPoste  : r.EfP,
      filles              : r.filles,
      garcons             : r.garcons,
      eleves              : (r.filles + r.garcons) || r.Comp
    })).sort((a,b)=> a.etablissement.localeCompare(b.etablissement));

    res.json({
      rows,
      region: {
        etablissements     : rows.length,
        apActifs           : regionTotals.ap.size,
        enseignantsTotaux  : regionTotals.EfT,
        enseignantsEnPoste : regionTotals.EfP,
        filles             : regionTotals.filles,
        garcons            : regionTotals.garcons,
        eleves             : (regionTotals.filles + regionTotals.garcons) || regionTotals.eleves,
        classesOuvertes    : Array.from(regionTotals.classes).sort()
      }
    });
  });

  // 3bis) Fichiers du personnel agrégés
  app.get('/api/summary/staff-files', isAuth, isInsp, withInsp, async (req,res)=>{
  const { annee, q='personnel', etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  if (annee)        f.annee = String(annee);
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const docs = await Collecte.find(f)
    .select('etablissement animateur fichiers uploads pieces createdAt')
    .lean();

  const byE = new Map();
  const push = (E, file, who, ts)=>{
    if (!file) return;
    const name = (typeof file==='string') ? file.split('/').pop()
               : (file.name || file.filename || file.path?.split('/').pop() || 'fichier');
    const path = (typeof file==='string') ? file : (file.path || file.url || file);
    if (!name) return;
    E.push({ name, path, animateur: (who||''), date: ts||null });
  };

  const kw = String(q).toLowerCase();
  for (const d of docs){
    const key = d.etablissement || '—';
    if (!byE.has(key)) byE.set(key, []);
    const list = byE.get(key);
    const all = []
      .concat(d.pieces||[])
      .concat(d.fichiers||[])
      .concat(d.uploads||[])
      .filter(Boolean);
    all.forEach(f=>{
      const name = (typeof f==='string') ? f : (f.name||f.filename||f.path||'');
      const s = String(name).toLowerCase();
      if (!kw || s.includes(kw)) push(list, f, d.animateur, d.createdAt);
    });
  }

  const rows = Array.from(byE.entries()).map(([etablissement,files])=>({
    etablissement,
    files: files.sort((a,b)=> (a.date?.toString()||'').localeCompare(b.date?.toString()||''))
  })).sort((a,b)=> a.etablissement.localeCompare(b.etablissement));

  res.json({ rows });
});

  // 5) Liste des dépôts reçus
  app.get('/api/summary/deposits', isAuth, isInsp, withInsp, async (req,res)=>{
  const { annee, cycle, specialite, evaluation, trimestre, etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };

  // 👇 ciblage par établissement/département (si fournis)
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;


    const docs = await Collecte.find(f).sort({ createdAt:-1 }).lean();
    const out = docs.map(d=>({
      id: String(d._id), etablissement: d.etablissement, animateur: d.animateur,
      cycle: d.cycle, specialite: d.specialite, evaluation: d.evaluation,
      annee: d.annee, createdAt: d.createdAt, classes: (d.classes||[]).length
    }));
    res.json({ rows: out });
  });

  // Lecture d'un dépôt
  app.get('/api/summary/deposits/:id', isAuth, isInsp, withInsp, async (req, res) => {
    const { id } = req.params;
    const doc = await Collecte.findOne({ _id: id, inspection: req.insp }).lean();
    if (!doc) return res.status(404).json({ error: 'not found' });

    const files = []
      .concat(doc.pieces || [])
      .concat(doc.fichiers || [])
      .concat(doc.uploads || [])
      .filter(Boolean)
      .map(f => {
        if (typeof f === 'string') return { name: f.split('/').pop(), path: f };
        return { name: f.name || f.filename || f.path?.split('/').pop() || 'fichier', path: f.path || f.url || f };
      });

    res.json({
      id: String(doc._id),
      etablissement: doc.etablissement,
      animateur: doc.animateur,
      cycle: doc.cycle,
      specialite: doc.specialite,
      evaluation: doc.evaluation,
      annee: doc.annee,
      createdAt: doc.createdAt,
      classes: doc.classes || [],
      files
    });
  });

  // Suppression d’un fichier uploadé
  app.delete('/api/uploads', isAuth, isInsp, async (req, res) => {
    try {
      const rel = (req.query.p || req.body?.path || '').toString().replace(/^\/+/, '');
      if (!rel) return res.status(400).json({ error: 'path manquant' });

      const root = path.join(process.cwd(), 'uploads');
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root)) return res.status(400).json({ error: 'path invalide' });

      await fs.promises.rm(abs, { force: true });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message || 'delete failed' });
    }
  });

  /* Accueil selon rôle */
  app.get('/', (req,res)=>{
    if(!req.user)               return res.render('home');
    if(req.user.role==='admin') return res.redirect('/admin');
    if(req.user.role==='insp')  return res.redirect('/inspector');
    return res.redirect('/collecte/nouvelle');
  });

  /* ===== Routes métier ===== */
  app.use(
  '/collecte',
  requireAuth,
  limitToInspection(),
  limitAnimToOwnEtab(),
  require('./routes/collecte')
);

  /* Fichiers (sécurisé) — inclut upload + suppression côté /fichiers */
  app.use(
  '/fichiers',
  requireAuth,
  limitToInspection(),   // filtre par inspection seulement
  fichiersRouter
);
  // APIs paramétrage
  app.use('/api/settings',    require('./routes/settings'));
  app.use('/api/inspections', require('./routes/inspections'));
  app.use('/api/disciplines', require('./routes/disciplines'));
  app.use('/api/presets',     require('./routes/presets'));
  app.use('/api/carte', isAuth, isInsp, withInsp, carteRoutes);

  // Submissions & messages – montés si présents
  if (fs.existsSync(path.join(__dirname,'routes','submissions.js'))) {
    app.use('/api/submissions', require('./routes/submissions'));
  }
  if (fs.existsSync(path.join(__dirname,'routes','messages.js'))) {
    app.use('/messages', require('./routes/messages'));
  }

  // Vue référentiel
  app.get('/referentiel/disciplines', (req,res)=>{
    const u=req.user;
    if(!u) return res.redirect('/login');
    if(!['insp','admin'].includes(u.role)) return res.status(403).send('forbidden');
    res.render('ref_disciplines',{ user:u });
  });

  // 404 JSON API
  app.use('/api', (_req,res)=> res.status(404).json({ error:'not found' }));

  /* ===== Socket.IO (chat) ===== */
  const { Server } = require('socket.io');
  const io = new Server(server, { cors:{ origin:true, credentials:true } });
  app.set('io', io);
  io.use((socket,next)=> sessionMiddleware(socket.request, {}, next));
  require('./server/sockets/chat')(io);

  /* ===== Error handler ===== */
  app.use((err, req, res, _next)=>{
    console.error('💥', err);
    if (req.path.startsWith('/api/') || req.path.startsWith('/fichiers')) {
      return res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
    res.status(500).send('Erreur serveur.');
  });

  /* Start */
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, ()=> console.log(`🚀  Serveur en ligne → http://localhost:${PORT}`));
})();


