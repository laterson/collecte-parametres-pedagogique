// models/Settings.js
const mongoose = require('mongoose');

const EffectifSchema = new mongoose.Schema({
  classe:  { type: String, trim: true },
  filles:  { type: Number, default: 0 },
  garcons: { type: Number, default: 0 }
}, { _id: false });

const StaffSchema = new mongoose.Schema({
  nom:     { type: String, trim: true },
  grade:   { type: String, trim: true },
  matiere: { type: String, trim: true },
  statut:  { type: String, trim: true },
  obs:     { type: String, trim: true },
  // on garde bien les affectations côté paramétrage
  classes:     [{ type: String, trim: true }],
  disciplines: [{ type: String, trim: true }]
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  inspection   : { type: String, required: true, index: true },
  etablissement: { type: String, required: true, index: true },
  annee        : { type: String, required: true, index: true },

  effectifs: [EffectifSchema],
  staff    : [StaffSchema]
}, { timestamps: true });

// ⚠️ clé d'unicité correcte (inclut l’inspection)
SettingsSchema.index(
  { inspection: 1, etablissement: 1, annee: 1 },
  { unique: true, name: 'uniq_insp_etab_annee' }
);

module.exports = mongoose.models.Settings || mongoose.model('Settings', SettingsSchema);
