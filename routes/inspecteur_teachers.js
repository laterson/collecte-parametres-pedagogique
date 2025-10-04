// routes/inspecteur_teachers.js
const express = require('express');
const router = express.Router();

/* ==== Auth middleware (robuste) ==== */
let attachUser, requireAuth;
(() => {
  const candidates = [
    '../server/middleware/auth',   // souvent le bon si tes autres routes sont sous /server
    '../middleware/auth',          // si ton middleware est directement sous /middleware
    './middleware/auth',
    '../../middleware/auth',
    '../../server/middleware/auth'
  ];
  let loaded = null;
  for (const p of candidates) {
    try {
      ({ attachUser, requireAuth } = require(p));
      loaded = p;
      console.log('[inspecteur_teachers] middleware/auth chargé depuis', p);
      break;
    } catch (_) {}
  }
  if (!loaded) {
    throw new Error('[inspecteur_teachers] Impossible de trouver middleware/auth (essaie ../server/middleware/auth).');
  }
})();

/* ==== Models ==== */
let Teacher = null; try { Teacher = require('../models/Teacher'); } catch {}
const Settings = require('../models/Settings');
let SchoolCard = null; try { SchoolCard = require('../models/SchoolCard'); } catch {}

/* ==== Helpers ==== */
const getYear = () => {
  const d = new Date(); const y = d.getFullYear(); const m = d.getMonth();
  return (m >= 7) ? `${y}-${y + 1}` : `${y - 1}-${y}`;
};
const norm  = v => String(v ?? '').trim();
const lower = v => norm(v).toLowerCase();

/** etab -> departement (à partir des cartes scolaires, racine ou meta.*) */
// avant: async function buildDeptMap(insp){ ... }
// AVANT : async function buildDeptMap(insp){ ... }
async function buildDeptMap(insp, annee){
  const map = new Map();
  if (!SchoolCard) return map;

  const q = {
    $or: [{ inspection: insp }, { 'meta.inspection': insp }]
  };
  if (annee) {
    // on ne retient que les cartes de l'année scolaire demandée
    q.$and = [{ $or: [{ annee }, { 'meta.annee': annee }] }];
  }

  const rows = await SchoolCard.find(q)
    .select('etablissement departement meta annee')
    .lean()
    .catch(()=>[]);

  for (const r of rows) {
    const etab = r.etablissement || r?.meta?.etablissement || '';
    const dept = r.departement  || r?.meta?.departement  || '—';
    if (etab) map.set(etab, dept);
  }
  return map;
}


/** Compose/écrit un CSV (séparateur ;) avec BOM UTF-8 */
function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const bom = '\uFEFF';
  const head = headers.join(';');
  const body = rows.map(r => headers.map(h => {
    const cell = r[h] ?? '';
    // échappe ; " et retours ligne
    const s = String(cell).replace(/"/g, '""');
    return /[;"\n\r]/.test(s) ? `"${s}"` : s;
  }).join(';')).join('\n');
  res.send(bom + head + '\n' + body);
}

/* =========================================================
 * GET /inspecteur/enseignants
 * Sert la page EJS (les lignes sont chargées via fetch côté client)
 * ========================================================= */
router.get('/inspecteur/enseignants', attachUser, requireAuth, async (req, res, next) => {
  try {
    const user = req.user || req.session?.user || null;
    const inspSpec = (user?.inspection || '').toString();  // spécialité = inspection

    const filters = {
      annee: String(req.query.annee || getYear()),
      departement: String(req.query.departement || ''),
      etab: String(req.query.etab || ''),
      q: String(req.query.q || '')
    };

    // Les données du tableau sont chargées ensuite par JS via /api/inspecteur/carte/region-staff
    res.render('inspecteur_teachers', {
      items: [],
      page: 1,
      limit: 50,
      total: 0,
      filters,
      user,
      inspSpec
    });
  } catch (e) { next(e); }
});

/* =========================================================
 * GET /inspecteur/enseignants/export.csv
 * Export CSV (colonnes réduites conformes au tableau demandé)
 * Filtres: ?annee=&departement=&etab=&q=
 * ========================================================= */
router.get('/inspecteur/enseignants/export.csv', attachUser, requireAuth, async (req, res, next) => {
  try {
    const userInsp = lower(req.user?.inspection || '');
    const annee = String(req.query.annee || '');
    const qDept = norm(req.query.departement || '');
    const qEtab = norm(req.query.etab || '');
    const qText = lower(req.query.q || '');

    // 1) carte des départements par établissement (filtrée par annee)
const deptMap = await buildDeptMap(userInsp, annee);

// si aucune carte pour l’année => export vide
if (!deptMap.size) {
  return sendCsv(res, `enseignants_${annee || 'all'}.csv`, [
    'No','Noms et prénoms','Matricule','Grade','Catégorie','Date de naissance','Sexe',
    "Région d'origine","Département d'origine","Arrondissement d'origine",
    "Date d'entrée à la fonction publique",'Poste occupé',"Date d’affectation ou de nomination",
    'Rang du poste','Contact téléphonique'
  ], []);
}

    // 2) on récupère le staff depuis Teacher (si dispo), sinon Settings.staff
    const out = [];

    // a) Teacher
    if (Teacher) {
      const tFilter = {};
      if (qEtab) tFilter.etablissement = qEtab;
      if (annee) tFilter.annee = annee;
      const tRows = await Teacher.find(tFilter).lean().catch(()=>[]);
      for (const p of (tRows || [])) {
  const etab = norm(p.etablissement);
  if (!deptMap.has(etab)) continue;        // <<< anti "fantômes" : pas de carte cette année = on saute
  const dept = deptMap.get(etab) || '—';

  // filtre département demandé
  if (qDept && dept !== qDept) continue;

  // filtre texte large
  const hay = [
    p.nomComplet || p.nom || '',
    p.matricule || '',
    p.grade || '',
    p.categorie || '',
    p.posteOccupe || '',
    p.telephone || ''
  ].join(' ').toLowerCase();
  if (qText && !hay.includes(qText)) continue;
        out.push({
          'No'                                       : '', // rempli par Excel ou à ignorer
          'Noms et prénoms'                          : p.nomComplet || p.nom || '',
          'Matricule'                                : p.matricule || '',
          'Grade'                                    : p.grade || '',
          'Catégorie'                                : p.categorie || '',
          'Date de naissance'                        : p.dateNaissance || '',
          'Sexe'                                     : p.sexe || '',
          "Région d'origine"                         : p.regionOrigine || '',
          "Département d'origine"                    : p.departementOrigine || '',
          "Arrondissement d'origine"                 : p.arrondissementOrigine || '',
          "Date d'entrée à la fonction publique"     : p.dateEntreeFP || '',
          'Poste occupé'                             : p.posteOccupe || '',
          "Date d’affectation ou de nomination"      : p.dateAffectation || '',
          'Rang du poste'                            : p.rangPoste || '',
          'Contact téléphonique'                     : p.telephone || ''
        });
      }
    }

    // b) Fallback Settings.staff (pour les établis. non couverts par Teacher)
    const sFilter = { inspection: userInsp };
    if (qEtab) sFilter.etablissement = qEtab;
    const sRows = await Settings.find(sFilter).select('etablissement staff').lean().catch(()=>[]);
   for (const s of (sRows || [])) {
  const etab = norm(s.etablissement);
  if (!deptMap.has(etab)) continue;        // <<< idem : saute les étabs sans carte active
  const dept = deptMap.get(etab) || '—';
  if (qDept && dept !== qDept) continue;

  for (const p of (s.staff || [])) {
    // filtre texte large
    const hay = [
      p.nom || '',
      p.matricule || '',
      p.grade || '',
      p.categorie || '',
      p.posteOccupe || '',
      p.telephone || ''
    ].join(' ').toLowerCase();
    if (qText && !hay.includes(qText)) continue;

        out.push({
          'No'                                       : '',
          'Noms et prénoms'                          : p.nom || '',
          'Matricule'                                : p.matricule || '',
          'Grade'                                    : p.grade || '',
          'Catégorie'                                : p.categorie || '',
          'Date de naissance'                        : p.dateNaissance || '',
          'Sexe'                                     : p.sexe || '',
          "Région d'origine"                         : p.regionOrigine || '',
          "Département d'origine"                    : p.departementOrigine || '',
          "Arrondissement d'origine"                 : p.arrondissementOrigine || '',
          "Date d'entrée à la fonction publique"     : p.dateEntreeFP || '',
          'Poste occupé'                             : p.posteOccupe || '',
          "Date d’affectation ou de nomination"      : p.dateAffectation || '',
          'Rang du poste'                            : p.rangPoste || '',
          'Contact téléphonique'                     : p.telephone || ''
        });
      }
    }

    // Tri simple par Nom & prénoms
    out.sort((a,b)=> String(a['Noms et prénoms']||'').localeCompare(String(b['Noms et prénoms']||''), 'fr'));

    // Envoi CSV
    const headers = [
      'No',
      'Noms et prénoms',
      'Matricule',
      'Grade',
      'Catégorie',
      'Date de naissance',
      'Sexe',
      "Région d'origine",
      "Département d'origine",
      "Arrondissement d'origine",
      "Date d'entrée à la fonction publique",
      'Poste occupé',
      "Date d’affectation ou de nomination",
      'Rang du poste',
      'Contact téléphonique'
    ];
    sendCsv(res, `enseignants_${annee || 'all'}.csv`, headers, out);
  } catch (e) { next(e); }
});
// --- Version imprimable (mise en page A4 paysage, en-têtes répétés)
router.get('/inspecteur/enseignants/print', requireAuth, async (req, res) => {
  const { annee = '', departement = '', etablissement = '', q = '' } = req.query || {};
  // on passe seulement les filtres à la vue (chargement des données côté client)
  const inspSpec = (req.user?.inspection || req.user?.specialite || '').toString();
  res.render('teachers_print', {
    user: req.user,
    inspSpec,
    filters: { annee, departement, etablissement, q }
  });
});

module.exports = router;
