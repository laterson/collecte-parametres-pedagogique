// models/Settings.js
const mongoose = require('mongoose');

/* Helpers de types sûrs */
const CleanString = { type: String, trim: true, default: '' };
const NonNegInt   = { type: Number, min: 0, default: 0 };

/* === Effectifs (inchangé, avec min/defauts robustes) === */
const EffectifSchema = new mongoose.Schema({
  classe : { type: String, trim: true, default: '' },
  filles : NonNegInt,
  garcons: NonNegInt
}, { _id: false });

/* === Personnel (format minimal + champs “fiche complète”) ===
   ⚠ Tous les nouveaux champs sont optionnels et par défaut vides.
   ⚠ On garde classes[] et disciplines[] en array de strings.
*/
const StaffSchema = new mongoose.Schema({
  nom: CleanString,
  prenom: CleanString,
  grade: CleanString,
  matiere: CleanString,
  statut: CleanString,
  obs: CleanString,
  matricule: CleanString,
  categorie: CleanString,
  sexe: { type: String, enum: ['M', 'F', ''], default: '' },
  dateNaissance: CleanString,
  telephone: CleanString,
  regionOrigine: CleanString,
  departementOrigine: CleanString,
  arrondissementOrigine: CleanString,
  posteOccupe: CleanString,
  rangPoste: CleanString,
  dateEntreeFP: CleanString,
  dateAffectation: CleanString,
  classes: { type: [{ type: String, trim: true }], default: [] },
  disciplines: { type: [{ type: String, trim: true }], default: [] }
}, { _id: false });


/* === Settings racine === */
const SettingsSchema = new mongoose.Schema({
  inspection   : { type: String, required: true, index: true, trim: true },
  etablissement: { type: String, required: true, index: true, trim: true },
  annee        : { type: String, required: true, index: true, trim: true },

  effectifs: { type: [EffectifSchema], default: [] },
  staff    : { type: [StaffSchema],   default: [] }
}, { timestamps: true });

/* Unicité */
SettingsSchema.index(
  { inspection: 1, etablissement: 1, annee: 1 },
  { unique: true, name: 'uniq_insp_etab_annee' }
);

module.exports = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
