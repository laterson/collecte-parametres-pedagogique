// models/Settings.js
const mongoose = require('mongoose');

/* Helpers de types sûrs */
const CleanString = { type: String, trim: true, default: '' };
const NonNegInt   = { type: Number, min: 0, default: 0 };

/* ============ Effectifs ============ */
/* V1 (compat): { classe, filles, garcons } */
const EffectifV1Schema = new mongoose.Schema({
  classe : { type: String, trim: true, default: '' }, // ex: "2nde AF1 (2)"
  filles : NonNegInt,
  garcons: NonNegInt
}, { _id: false });

/* V2 (divisions) : { canonicalClass, divisions, effectifs: [{divisionIndex, filles, garcons}] } */
const EffectifDivisionSchema = new mongoose.Schema({
  divisionIndex: { type: Number, min: 1, default: 1 },
  filles       : NonNegInt,
  garcons      : NonNegInt
}, { _id: false });

const EffectifV2Schema = new mongoose.Schema({
  canonicalClass: { type: String, trim: true, default: '' }, // ex: "2nde AF1"
  divisions     : { type: Number, min: 1, default: 1 },
  effectifs     : { type: [EffectifDivisionSchema], default: [] }
}, { _id: false });

/*
  ⚠️ Tes routes acceptent V1 *ou* V2 dans le même champ `effectifs`.
  Pour garantir la compatibilité sans CastError, on déclare `effectifs` en Mixed.
  (Si tu veux forcer un seul format, remplace Mixed par [EffectifV1Schema] ou [EffectifV2Schema].)
*/

/* ============ Personnel (staff) ============ */
/* Format minimal + fiche complète (tous les champs sont facultatifs) */
const StaffSchema = new mongoose.Schema({
  nom   : CleanString,
  prenom: CleanString,
  grade : CleanString,
  matiere: CleanString,
  statut: CleanString,
  obs   : CleanString,

  // Champs RH (V2)
  matricule : CleanString,
  categorie : CleanString,
  sexe      : { type: String, enum: ['M', 'F', ''], default: '' },
  dateNaissance: CleanString,
  telephone : CleanString,

  regionOrigine       : CleanString,
  departementOrigine  : CleanString,
  arrondissementOrigine: CleanString,

  posteOccupe : CleanString,
  rangPoste   : CleanString,
  dateEntreeFP: CleanString,
  dateAffectation: CleanString,

  // Pédagogie locale
  classes    : { type: [{ type: String, trim: true }], default: [] },
  disciplines: { type: [{ type: String, trim: true }], default: [] }
}, { _id: false });

/* ============ Disciplines paramétrées par classe ============ */
/*
  On enregistre le libellé EXACT de la classe tel que vu dans la modale.
  Il peut s'agir :
    - d'une base ("2nde AF1")
    - d'une division précise ("2nde AF1 (2)")
*/
const DisciplinesByClassSchema = new mongoose.Schema({
  classe     : { type: String, required: true, trim: true, default: '' },
  disciplines: { type: [{ type: String, trim: true }], default: [] }
}, { _id: false });

/* ============ Schéma racine Settings ============ */
const SettingsSchema = new mongoose.Schema({
  inspection   : { type: String, required: true, index: true, lowercase: true, trim: true },
  etablissement: { type: String, required: true, index: true, trim: true },
  annee        : { type: String, required: true, index: true, trim: true },

  /*
    Effectifs : on laisse Mixed pour accepter V1 et V2 simultanément
    (tes routes /api/settings POST/PUT posent directement ce qui arrive du front).
    Exemple d'élément V1: { classe, filles, garcons }
    Exemple d'élément V2: { canonicalClass, divisions, effectifs:[...] }
  */
  effectifs: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Personnel (array de fiches)
  staff: { type: [StaffSchema], default: [] },

  // ✅ Clé qui manquait et causait la non-persistence des matières
  disciplinesByClass: { type: [DisciplinesByClassSchema], default: [] },

  // Optionnel : fichiers liés au staff (importés, etc.)
  staffFiles: { type: [mongoose.Schema.Types.Mixed], default: [] }
}, {
  timestamps: true,
  strict: true,
  minimize: true
});

/* Unicité par inspection × établissement × année */
SettingsSchema.index(
  { inspection: 1, etablissement: 1, annee: 1 },
  { unique: true, name: 'uniq_insp_etab_annee' }
);

/* (Optionnel) petite normalisation en entrée */
SettingsSchema.pre('save', function normalize() {
  if (typeof this.inspection === 'string') this.inspection = this.inspection.toLowerCase().trim();
  if (typeof this.etablissement === 'string') this.etablissement = this.etablissement.trim();
  if (typeof this.annee === 'string') this.annee = this.annee.trim();
});

module.exports = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
