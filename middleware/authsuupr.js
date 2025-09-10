// middleware/auth.js
exports.isAuth = (req, res, next) =>
  req.session?.user ? next() : res.status(401).json({ error: 'auth required' });

exports.isAdmin = (req, res, next) =>
  req.session?.user?.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' });

exports.isInsp = (req, res, next) =>
  req.session?.user?.role === 'insp' ? next() : res.status(403).json({ error: 'inspecteur only' });

exports.isAnim = (req, res, next) =>
  req.session?.user?.role === 'anim' ? next() : res.status(403).json({ error: 'animateur only' });


