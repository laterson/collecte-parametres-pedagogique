// server/middleware/scope.js

/**
 * Cloisonnement par inspection :
 * - admin : accès libre (peut consulter n'importe quelle inspection)
 * - insp  : forcé sur sa propre inspection
 * - anim  : forcé sur sa propre inspection
 *
 * Effet :
 * - GET : impose req.query.inspection = req.user.inspection (sauf admin)
 * - POST/PUT/PATCH : impose req.body.inspection = req.user.inspection (sauf admin)
 * - Bloque toute tentative de passer une autre inspection via query/body (403)
 */
function limitToInspection() {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth required' });

    const userInsp = String(req.user.inspection || '').toLowerCase();
    const isAdmin  = req.user.role === 'admin';

    // Si admin -> libre
    if (isAdmin) return next();

    // Vérifie requêtes qui tentent d'imposer une autre inspection
    const qInsp = req.query?.inspection ? String(req.query.inspection).toLowerCase() : null;
    const bInsp = req.body?.inspection ? String(req.body.inspection).toLowerCase() : null;

    if (qInsp && qInsp !== userInsp) {
      return res.status(403).json({ error: 'forbidden: wrong inspection in query' });
    }
    if (bInsp && bInsp !== userInsp) {
      return res.status(403).json({ error: 'forbidden: wrong inspection in body' });
    }

    // Injection silencieuse (garantit le bon filtre côté routes)
    if (req.method === 'GET' || req.method === 'DELETE') {
      req.query = { ...req.query, inspection: userInsp };
    } else if (req.body && typeof req.body === 'object') {
      req.body.inspection = userInsp;
    }

    next();
  };
}

/**
 * Limitation AP à son propre établissement :
 * - admin & insp : accès multi-établissements
 * - anim        : forcé sur son établissement (lecture/écriture)
 *
 * Effet :
 * - GET/DELETE : impose req.query.etablissement = req.user.etab
 * - POST/PUT/PATCH : impose req.body.etablissement = req.user.etab
 * - Bloque tentative de cibler un autre établissement (403)
 */
function limitAnimToOwnEtab() {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'auth required' });

    const isAdmin = req.user.role === 'admin';
    const isInsp  = req.user.role === 'insp';
    if (isAdmin || isInsp) return next();

    // Ici : role === 'anim'
    const etab = req.user.etab || '';

    // Refuse un autre établissement explicitement demandé
    const qEtab = req.query?.etablissement ? String(req.query.etablissement) : null;
    const bEtab = req.body?.etablissement ? String(req.body.etablissement) : null;

    if (qEtab && qEtab !== etab) {
      return res.status(403).json({ error: 'forbidden: wrong etablissement in query' });
    }
    if (bEtab && bEtab !== etab) {
      return res.status(403).json({ error: 'forbidden: wrong etablissement in body' });
    }

    // Injecte automatiquement le bon établissement
    if (req.method === 'GET' || req.method === 'DELETE') {
      req.query = { ...req.query, etablissement: etab };
    } else if (req.body && typeof req.body === 'object') {
      req.body.etablissement = etab;
    }

    next();
  };
}

module.exports = { limitToInspection, limitAnimToOwnEtab };
