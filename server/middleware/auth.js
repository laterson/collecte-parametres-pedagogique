/* server/middleware/auth.js */
const onApiPath = req => req.path.startsWith('/api') || req.path.startsWith('/fichiers');

function attachUser(req, _res, next){
  // Injecte `req.user` depuis la session si présente
  const u = req.session?.user;
  req.user = u ? {
    id         : u.id,
    nom        : u.nom,
    etab       : u.etab,
    etabId     : u.etabId || null,
    departement: u.departement || '',
    departementCode: u.departementCode || '',
    role       : u.role,
    inspection : (u.inspection || 'artsplastiques').toLowerCase(),
    specialite : u.specialite || ''
  } : null;
  next();
}


function requireAuth(req, res, next){
  if (req.user) return next();
  // API → JSON, sinon → redirection login
  if (onApiPath(req) || req.headers.accept?.includes('application/json')){
    return res.status(401).json({ error:'auth required' });
  }
  return res.redirect('/login');
}

function requireRole(role){
  return (req, res, next)=>{
    if (!req.user) return requireAuth(req,res,next);
    if (req.user.role !== role){
      return res.status(403).json({ error:'forbidden' });
    }
    next();
  };
}
function requireAnyRole(roles = []) {
  const set = new Set(roles);
  return (req, res, next) => {
    if (!req.user) return requireAuth(req,res,next);
    if (set.has(req.user.role) || req.user.role === 'admin') return next(); // admin passe-partout
    return res.status(403).json({ error: 'forbidden' });
  };
}

// Rotation d’ID de session (anti-fixation)
function regenerateSession(req){
  return new Promise((resolve, reject)=>{
    req.session.regenerate(err => err ? reject(err) : resolve());
  });
}

module.exports = { attachUser, requireAuth, requireRole, regenerateSession, requireAnyRole };



