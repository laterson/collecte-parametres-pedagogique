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
const inspecteurTeachers = require('./routes/inspecteur_teachers');
const inspTeach = require('./routes/inspecteur_teachers');


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


// 👇 AJOUTER ICI (global, une seule fois)
function splitClassLabel(label){
  const raw0 = String(label || '')
    .replace(/\u00A0/g, ' ')      // remplace les espaces insécables
    .replace(/\s+/g, ' ')         // normalise les espaces multiples
    .trim();
  // repère "(2)", "#2", "/2", "-2", "div 2", "division 2", "section 2", ou suffixes G/S + chiffre
  const m = raw0.match(/\s*(?:\(|#|\/|-|\bdiv(?:ision)?\b|\bsection\b|[GgSs])\s*(\d+)\s*\)?\s*$/u);
  if (!m) return { base: raw0, division: 1 };
  return { base: raw0.slice(0, m.index).trim(), division: Number(m[1] || '1') || 1 };
}

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

// Dernier timestamp d'un document Collecte
function bestTs(doc){
  const ca = doc?.createdAt ? new Date(doc.createdAt).getTime() : 0;
  const dd = doc?.dateDepot ? new Date(doc.dateDepot).getTime() : 0;
  let oidTs = 0;
  try { oidTs = doc?._id?.getTimestamp?.().getTime?.() || 0; } catch(_) {}
  return Math.max(ca, dd, oidTs);
}

function keyOf(label){
  return String(label || '')
    .replace(/\u00A0/g,' ')                // supprime espaces insécables
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // enlève les accents
    .replace(/\s+/g,' ')                   // espaces multiples → un
    .trim()
    .toUpperCase();
}



function buildFormViewForClass(fiches, expectedList, classeName, expectedEvalCount = 6) {
  const expected = Array.isArray(expectedList) ? expectedList : [];
  const expectedOrder = new Map(expected.map((n, i) => [n, i]));

  // --- base pour les comparaisons strictes (sans espaces/accents)
  const wantedBase = normStrict(splitClassLabel(classeName).base);

  // --- NE PAS utiliser normStrict pour détecter "1ère année"
  //     (on garde les espaces, on enlève juste les accents et on met en minuscule)
  const baseRaw  = splitClassLabel(classeName).base || '';
  const baseNorm = baseRaw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const isFirstYearClass = /^(?:1(?:ere|re)?|premiere)\b/.test(baseNorm);


  // ---- 1) ne garder que le DERNIER dépôt par (etab|anim)
  const latest = new Map();
  for (const d of (fiches || [])) {
    const k = `${d.etablissement || '—'}|${d.animateur || '—'}`;
    const cur = latest.get(k);
    if (!cur || bestTs(d) > bestTs(cur)) latest.set(k, d);
  }
  const docs = [...latest.values()];

  // ---- 2) agrégat strict pour la CLASSE demandée (fusion divisions)
  const perDisc = {};                 // KEY -> { label, totals }
  const presentByDepot = new Map();   // depKey -> Set(KEY)
  const etabsInClass = new Set();

  for (const F of docs) {
    const matches = (F.classes || []).filter(c => {
      const base = normStrict(splitClassLabel(c?.nom || '').base);
      return base === wantedBase;
    });
    if (!matches.length) continue;
    etabsInClass.add(F.etablissement || '—');
    const depKey = `${F.etablissement || '—'}|${F.animateur || '—'}`;
    const have = presentByDepot.get(depKey) || new Set();

    for (const cl of matches) {
      getDiscs(cl).forEach(d => {
        const label = String(d.discipline ?? d.nom ?? d.name ?? '').replace(/\u00A0/g, ' ').trim();
        if (!label) return;
        const KEY = label.toUpperCase();

        if (!perDisc[KEY]) perDisc[KEY] = { label, totals: emptyTotals() };
        addTotals(perDisc[KEY].totals, d);
        have.add(KEY);
      });
    }
    presentByDepot.set(depKey, have);
  }

  // ---- 3) INTERSECTION stricte: seulement les KEY présentes dans TOUS les dépôts
  const sets = [...presentByDepot.values()];
  const totalDepots = sets.length;
  const common = (() => {
    if (!sets.length) return new Set();
    const out = new Set(sets[0]);
    for (const s of sets.slice(1))
      for (const v of Array.from(out))
        if (!s.has(v)) out.delete(v);
    return out;
  })();

 // ---- 3bis) INCOHÉRENCES (sur les DERNIERS dépôts uniquement)
const depList = [...presentByDepot.entries()]; // [ "etab|ap", Set(KEY) ]
const totalDepotsLatest = depList.length;

// Compter par discipline le nombre de dépôts "latest" où elle apparaît
const countLatest = new Map();
for (const [, have] of depList) {
  for (const KEY of have) {
    countLatest.set(KEY, (countLatest.get(KEY) || 0) + 1);
  }
}

// Union des disciplines observées sur les "latest"
const unionLatest = new Set(countLatest.keys());

// Détails des incohérences (présente quelque part mais pas partout)
const incoherences = [...unionLatest]
  .filter(KEY => {
    if (!totalDepotsLatest) return false;
    const c = countLatest.get(KEY) || 0;
    // Cas 1ère année : TECHNOLOGIE doit être partout → incohérence si c < total
    if (isFirstYearClass && KEY === 'TECHNOLOGIE') return c > 0 && c < totalDepotsLatest;
    // Règle générale : c > 0 et c < total → incohérent
    return c > 0 && c < totalDepotsLatest;
  })
  .map(KEY => {
    const details = depList
      .filter(([, have]) => !have.has(KEY))
      .map(([depKey]) => {
        const [etab, ap] = depKey.split('|');
        return { etab, ap };
      });
    const presentIn = countLatest.get(KEY) || 0;
    const coverage = Number(((presentIn / totalDepotsLatest) * 100).toFixed(2));
    return {
      nom       : (perDisc[KEY]?.label) || KEY,
      presentIn,
      missingIn : totalDepotsLatest - presentIn,
      coverage,
      details
    };
  })
  .sort((a, b) => (a.coverage - b.coverage) || a.nom.localeCompare(b.nom, 'fr'));

// Ensemble des disciplines incohérentes par leur KEY (majuscules)
const incoherentKeys = new Set(
  [...unionLatest].filter(KEY => {
    const c = countLatest.get(KEY) || 0;
    if (!totalDepotsLatest) return false;
    // On laisse passer TECHNOLOGIE en 1ère année même si incohérente (elle sera gérée au filtre)
    if (isFirstYearClass && KEY === 'TECHNOLOGIE') return false;
    return c > 0 && c < totalDepotsLatest;
  })
);
 
 // ---- 4) Construction des lignes affichées : exclure les disciplines incohérentes
const rows = Object.entries(perDisc)
  .filter(([KEY]) => {
    // Masquer TECHNOLOGIE si ce n’est pas une 1ère année
    if (KEY === 'TECHNOLOGIE' && !isFirstYearClass) return false;

    // ⛔️ Exclure les disciplines incohérentes du tableau de synthèse
    if (incoherentKeys.has(KEY)) return false;

    // Sinon on garde
    return true;
  })
  .map(([, obj]) => {
    const P = packTotals(obj.totals);
    return { nom: obj.label, ...P };
  })
  .sort((a, b) => {
    const ai = expectedOrder.has(a.nom) ? expectedOrder.get(a.nom) : 1e9;
    const bi = expectedOrder.has(b.nom) ? expectedOrder.get(b.nom) : 1e9;
    if (ai !== bi) return ai - bi;
    return a.nom.localeCompare(b.nom, 'fr');
  });


// total = somme des lignes retenues (les incohérentes n'étant plus dans rows, elles ne faussent plus les stats)
const totalT = rows.reduce((T, r) => {
  const back = {
    Hd: r.Hd, Hf: r.Hf, Lp: r.Lp, Lf: r.Lf, Ldp: r.Ldp, Ldf: r.Ldf,
    Tp: r.Tp, Tf: r.Tf, Tdp: r.Tdp, Tdf: r.Tdf, Comp: r.Comp, M10: r.M10, EffT: r.EffT, EffP: r.EffP
  };
  addTotals(T, back);
  return T;
}, emptyTotals());

  return {
    classe: splitClassLabel(classeName).base,
    etablissements: etabsInClass.size,
    disciplines: rows,
    incoherences,
    total: packTotals(totalT),
    expected
  };
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
  
app.use('/api/teachers', require('./routes/teachers'));
app.use('/inspecteur/enseignants', inspTeach);

app.use('/', inspecteurTeachers);
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

// === Progression dépôts par établissement (bas: attendu vs reçus) ===
app.get('/api/summary/progress', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, classe, etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  // nb d’évals attendues dans la période
  const expectedEvalCount =
    evaluation ? 1 :
    (trimestre ? (TRI[trimestre]?.length || 0) : 6);

  // Filtre classe (fusion divisions)
  const needClass = Boolean(classe);
  const wantedBase = needClass
    ? normStrict(splitClassLabel(classe).base)
    : null;

  // On compte par établissement :
  // - apSet : AP “actifs” (qui ont déposé sur cette classe/sélection)
  // - pairs : couples uniques (animateur|evaluation) reçus
  const byEtab = new Map();
  const docs = await Collecte.find(f).lean();

  for (const F of docs){
    // si on filtre une classe précise, on ne retient que les dépôts qui la contiennent (divisions fusionnées)
    if (needClass) {
      const matches = (F.classes||[]).some(c => {
        const base = normStrict(splitClassLabel(c?.nom || '').base);
        return base === wantedBase;
      });
      if (!matches) continue;
    }

    const E = F.etablissement || '—';
    if (!byEtab.has(E)) byEtab.set(E, { apSet:new Set(), pairs:new Set() });

    const r = byEtab.get(E);
    const ap = (F.animateur || '—').trim();
    const ev = Number(F.evaluation)||0;

    if (ap) r.apSet.add(ap);
    if (ap && ev) r.pairs.add(`${ap}|${ev}`);
  }

  const rows = Array.from(byEtab.entries()).map(([etablissement, r])=>{
    const apCount   = r.apSet.size;
    const expected  = apCount * (expectedEvalCount || 0);
    const received  = r.pairs.size;
    const rate      = expected ? Number(((received/expected)*100).toFixed(1)) : 0;
    return { etablissement, ap: apCount, expected, received, rate };
  }).sort((a,b)=> (a.rate - b.rate) || a.etablissement.localeCompare(b.etablissement));

  res.json({ rows, expectedEvalCount });
});

  app.get('/api/summary/by-etab', isAuth, isInsp, withInsp, async (req,res)=>{
  const { cycle, specialite, evaluation, trimestre, etablissement, departement, classe } = req.query;
    const wantClass = Boolean(classe);
  const baseCible = wantClass ? normStrict(splitClassLabel(classe).base) : null;

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
      const base = normStrict(splitClassLabel(c?.nom||'').base);
      if (wantClass && base !== baseCible) return;
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
      const key = splitClassLabel(c.nom || '').base || '—';
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
  const base = splitClassLabel(c.nom || '').base;
  const name = String(base || '').trim();
  if (name) discovered.add(name);
});

  let classNames = Array.from(discovered).sort((a,b)=> a.localeCompare(b));
  if (!classNames.length) {
    const preset = await SpecPreset.findOne({ inspection:req.insp, cycle:String(cycle), specialite:SPEC }).lean();
    classNames = (preset?.classes?.length ? preset.classes : (CLASSES_BY_SPEC[SPEC] || []));
  }

  // nb d'évals attendues selon le filtre : 1 (eval X), 2 (T1/T2/T3), 6 (annuel)
  const expectedEvalCount =
    evaluation ? 1 :
    (trimestre ? (TRI[trimestre]?.length || 0) : 6);

  const build = (name)=> buildFormViewForClass(
    fiches,         // dépôts filtrés
    expected,       // référentiel de disciplines
    name,           // classe
    expectedEvalCount
  );
  if (classe) return res.json(build(classe));
  res.set('Cache-Control','no-store');
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
app.use(
 '/api/ap',
  requireAuth,
  requireRole('anim'),
  limitToInspection(),
  limitAnimToOwnEtab(),
  require('./routes/ap')
);
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
     const classes = (F.classes||[])
  .map(c => splitClassLabel(c.nom || '').base)
  .map(s => String(s).trim())
  .filter(Boolean);
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

  // 2) KPI (mixe Carte scolaire + Paramètres pédagogiques)
app.get('/api/summary/kpis', isAuth, isInsp, withInsp, async (req,res)=>{
  const { annee, cycle, specialite, classe, evaluation, trimestre, etablissement, departement } = req.query;

  // ---- Filtre commun pour les collectes (pédagogie + effectifs élèves)
  const f = { inspection:req.insp };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  // ---- 1) Récup collecte (pour taux + élèves)
  const fiches = await Collecte.find(f).lean();

  // ---- 2) Récup personnel enseignant (carte scolaire)
  // (La collection Teacher n’a pas cycle/specialité; on filtre sur insp + (annee) + (etab si fourni))
  const ft = { inspection:req.insp };
  if (annee)      ft.annee = String(annee);
  if (etablissement) ft.etablissement = etablissement;
  // (si tu stockes departement dans Teacher, ajoute-le ici)
  const profs = await Teacher.find(ft).lean();

  // ---- 3) Agrégations communes
  const etablissements = new Set();
  const apActifs       = new Set();
  let depots           = 0;

  // Taux pédagogiques (depuis disciplines)
  const Taux = emptyTotals();

  // Élèves (depuis carte scolaire => classes[].filles/garcons ; fallback comp)
  let filles = 0, garcons = 0, fallbackComp = 0;

  for (const F of fiches){
    depots += 1;
    etablissements.add(F.etablissement || '—');
    if (F.animateur) apActifs.add(F.animateur);

    // Classes filtrées par "classe" (fusion des divisions)
    for (const c of (F.classes||[])) {
      if (classe) {
        const baseCible    = normStrict(splitClassLabel(classe).base);
        const baseCourante = normStrict(splitClassLabel(c.nom || '').base);
        if (baseCourante !== baseCible) continue;
      }

      // élèves carte scolaire
      const fC = Number(c.filles||0);
      const gC = Number(c.garcons||0);
      filles  += fC;
      garcons += gC;

      // taux depuis disciplines
      getDiscs(c).forEach(d => {
        addTotals(Taux, d);
        // fallback élèves (si pas de saisie filles/garçons)
        fallbackComp += n(d, 'comp','Comp');
      });
    }
  }

  // Élèves total
  const totalEleves = (filles + garcons) || fallbackComp;

  // Enseignants (depuis Teacher)
  const enseignantsTotaux  = profs.length;
  // Heuristique simple "en poste" : statut non vide et pas marqué "vacant"/"non affecté"
  const enseignantsEnPoste = profs.filter(p => !String(p.statut||'').match(/vacant|non\s*affecte/i)).length;

  // Taux pédagogiques
  const P = packTotals(Taux);

  res.json({
    etablissements: etablissements.size,
    apActifs:       apActifs.size,
    depots,
    effectifsRegion: {
      enseignantsTotaux,
      enseignantsEnPoste,
      eleves: totalEleves
    },
    taux: {
      couvertureHeures:      P.H,
      leconsFaites:          P.Pc,
      leconsDigitalFaites:   P.Pd,
      tpFaits:               P.Tc,
      tpDigitalFaits:        P.Td,
      reussite:              P.R
    }
  });
});


  // 3) Carte scolaire régionale (agrège divisions, élèves & enseignants)
app.get('/api/summary/school-map', isAuth, isInsp, withInsp, async (req,res)=>{
  const { annee, evaluation, trimestre, cycle, specialite, etablissement, departement } = req.query;

  const f = { inspection:req.insp };
  if (annee)      f.annee = String(annee);
  if (cycle)      f.cycle = String(cycle);
  if (specialite) f.specialite = String(specialite).toUpperCase();
  if (evaluation) f.evaluation = Number(evaluation);
  else if (trimestre) f.evaluation = { $in: TRI[trimestre]||[] };
  if (etablissement) f.etablissement = etablissement;
  if (departement)   f.departement   = departement;

  const fiches = await Collecte.find(f).lean();

  // Préchargement du personnel par établissement
  const ft = { inspection:req.insp };
  if (annee)      ft.annee = String(annee);
  // si filtre établissement unique, on le met; sinon on chargera par set des etab plus bas
  const allTeachers = await Teacher.find(ft).lean();
  const byEtabTeachers = new Map();
  for (const t of allTeachers){
    const key = t.etablissement || '—';
    if (!byEtabTeachers.has(key)) byEtabTeachers.set(key, []);
    byEtabTeachers.get(key).push(t);
  }

  // Agrégation par établissement
  const byE = new Map();
  const region = { ap:new Set(), filles:0, garcons:0, eleves:0, classes:new Set(), ensT:0, ensP:0 };

  for (const F of fiches){
    const key = F.etablissement || '—';
    if (!byE.has(key)) byE.set(key, {
      etablissement:key,
      cycles:new Set(),
      classesOuvertes:new Set(),
      apNoms:new Set(),
      filles:0, garcons:0, compFallback:0
    });
    const r = byE.get(key);

    r.cycles.add(F.cycle);
    if (F.animateur){ r.apNoms.add(F.animateur); region.ap.add(F.animateur); }

    for (const c of (F.classes||[])){
      const base = splitClassLabel(c.nom || '').base.trim();
      if (base){ r.classesOuvertes.add(base); region.classes.add(base); }

      // élèves par classe (carte scolaire)
      const fC = Number(c.filles||0), gC = Number(c.garcons||0);
      r.filles += fC;  r.garcons += gC;
      region.filles  += fC; region.garcons += gC;

      // fallback comp depuis disciplines
      getDiscs(c).forEach(d => { r.compFallback += n(d,'comp','Comp'); });
    }
  }

  // Injecte le personnel issu de Teacher
  const rows = Array.from(byE.values()).map(r=>{
    const profs = byEtabTeachers.get(r.etablissement) || [];
    const ensT  = profs.length;
    const ensP  = profs.filter(p => !String(p.statut||'').match(/vacant|non\s*affecte/i)).length;

    // maj région
    region.ensT += ensT; region.ensP += ensP;

    const eleves = (r.filles + r.garcons) || r.compFallback;

    return {
      etablissement      : r.etablissement,
      cyclesOuverts      : Array.from(r.cycles).sort(),
      classesOuvertes    : Array.from(r.classesOuvertes).sort(),
      apList             : Array.from(r.apNoms).sort(),
      apActifs           : r.apNoms.size,
      enseignantsTotaux  : ensT,
      enseignantsEnPoste : ensP,
      filles             : r.filles,
      garcons            : r.garcons,
      eleves
    };
  }).sort((a,b)=> a.etablissement.localeCompare(b.etablissement));

  const regionEleves = (region.filles + region.garcons) || rows.reduce((s,x)=> s + (x.eleves||0), 0);

  res.json({
    rows,
    region:{
      etablissements     : rows.length,
      apActifs           : region.ap.size,
      enseignantsTotaux  : region.ensT,
      enseignantsEnPoste : region.ensP,
      filles             : region.filles,
      garcons            : region.garcons,
      eleves             : regionEleves,
      classesOuvertes    : Array.from(region.classes).sort()
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

  // Accueil : si pas connecté → login.ejs ; sinon → redirection selon rôle
app.get('/', (req, res) => {
  if (!req.user) {
    const role = ['admin','anim','insp'].includes(req.query.role) ? req.query.role : 'anim';
    return res.render('login', { error: null, role }); // 👈 on rend login.ejs ici
  }
  if (req.user.role === 'admin') return res.redirect('/admin');
  if (req.user.role === 'insp')  return res.redirect('/inspector');
  return res.redirect('/collecte/nouvelle');
});

  /* ===== Routes métier ===== */
  app.use(
  '/collecte',
  requireAuth,
  limitToInspection(),
  limitAnimToOwnEtab(),
  requireRole('anim'), 
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
 app.use(
   '/api/settings',
   requireAuth,
   limitToInspection(),   // impose req.query/body.inspection = req.user.inspection
   limitAnimToOwnEtab(),  // impose req.query/body.etablissement = req.user.etab (pour anim)
   require('./routes/settings')
 );
 app.use('/api/inspections', requireAuth, limitToInspection(), require('./routes/inspections'));
 app.use('/api/disciplines', requireAuth, limitToInspection(), require('./routes/disciplines'));
 app.use('/api/presets',     requireAuth, limitToInspection(), require('./routes/presets'));
  app.use('/api/carte', isAuth, isInsp, withInsp, carteRoutes);
// ⬇️ Alias pour les appels qui commencent par /api/inspecteur/carte/...
app.use('/api/inspecteur/carte', isAuth, isInsp, withInsp, carteRoutes);
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
/* -------- PURGE DES DONNÉES (anim) -------- */
app.post('/api/purge', async (req, res) => {
  try {
    // sécurités déjà en place pour /api via app.use('/api', requireAuth, limitToInspection(), limitAnimToOwnEtab())
    const u = req.user; // { id, nom, etab, inspection, role, ... }
    const {
      annee,                          // optionnel (ex: "2025-2026")
      options = {                     // cases à cocher dans la modale
        collectes: true,
        settings : true,
        files    : true,
        chat     : true,
      }
    } = req.body || {};

    const fBase = {
      inspection  : String(u.inspection || '').toLowerCase(),
      etablissement: u.etab,
    };
    if (annee) fBase.annee = String(annee);

    const ops = [];

    /* 1) Fiches de collecte de l'animateur (toutes évaluations) */
    if (options.collectes) {
      // Dans tes collectes, l’animateur est stocké en clair (voir soumettre() côté front)
      ops.push(Collecte.deleteMany({ ...fBase, animateur: u.nom }));
    }

    /* 2) Paramètres établissement (effectifs, personnel, baselines) */
    if (options.settings) {
      // Les Settings ne sont pas par utilisateur mais par établissement/année/inspection
      // → on supprime la configuration de l’établissement de l’animateur
      const q = { ...fBase };
      delete q.etablissement; // on garde l’etab ci-dessous
      ops.push(Settings.deleteMany({ inspection: fBase.inspection, etablissement: u.etab, ...(annee ? { annee } : {}) }));
      ops.push(Baseline.deleteMany({ inspection: fBase.inspection, etablissement: u.etab, ...(annee ? { annee } : {}) }));
    }

    /* 3) Fichiers partagés (dans /uploads) */
    if (options.files) {
      const uploadsRoot = path.join(process.cwd(), 'uploads');
      // Dans la plupart des installs on a un arborescence du type /uploads/<inspection>/<etablissement>/...
      const dir1 = path.join(uploadsRoot, String(u.inspection || '').toLowerCase(), u.etab);
      // Sécurise le chemin et supprime récursivement si présent
      const safeRm = async (abs) => {
        if (!abs.startsWith(uploadsRoot)) return; // garde-fou
        try { await fs.promises.rm(abs, { recursive: true, force: true }); } catch (_) {}
      };
      await safeRm(dir1);
    }

    /* 4) Messages du forum / chat temps réel */
    if (options.chat) {
      // Le modèle importé en haut s’appelle Message
      // On supprime les messages écrits par cet utilisateur dans son inspection (etabl. si tu veux limiter)
      const q = { inspection: fBase.inspection, from: u.nom };
      // si tu stockes l’établissement dans le message, dé-commente la ligne suivante
      // q.etablissement = u.etab;
      ops.push(Message.deleteMany(q));
    }

    await Promise.all(ops);

    // Optionnel: notifier via socket.io
    try { req.app.get('io')?.emit('admin:purge', { ok:true, user:u.nom, etab:u.etab }); } catch (_) {}

    res.json({ ok:true, message:'Les données sélectionnées ont été supprimées.' });
  } catch (e) {
    console.error('PURGE /api/purge error:', e);
    res.status(500).json({ error: e.message || 'server_error' });
  }
});




  /* ===== Socket.IO (chat) ===== */
  const { Server } = require('socket.io');
  const io = new Server(server, { cors:{ origin:true, credentials:true } });
  app.set('io', io);
  io.use((socket,next)=> sessionMiddleware(socket.request, {}, next));
  require('./server/sockets/chat')(io);

 // 🔽 place ce bloc APRÈS app.set('io', io) et require('./server/sockets/chat')(io)

const chatStore = require('./db/chat'); // ou utilise attachChat.purge

app.delete('/api/chat/reset', requireAuth, requireRole('insp'), async (req, res) => {
  try {
    const inspection = String(req.query.inspection || req.user?.inspection || '').trim().toLowerCase();
    if (!inspection) return res.status(400).json({ ok:false, error:'inspection required' });

    const room = `insp:${inspection}`;
    chatStore.clearRoom(room);            // ✅ on efface la room dans SQLite

    const io = req.app.get('io');
    io.to(room).emit('chat:history', []); // vide chez les clients
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});



  // 404 JSON API
  app.use('/api', (_req,res)=> res.status(404).json({ error:'not found' }));
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


