// models/Baseline.js
const mongoose = require('mongoose');

const BaselineSchema = new mongoose.Schema({
  etablissement: { type: String, index: true, required: true },
  annee       : { type: String, index: true, required: true },
  cycle       : { type: String, enum: ['premier','second'], required: true },
  specialite  : { type: String, required: true },
  classe      : { type: String, required: true },
  discipline  : { type: String, required: true },

  // Cibles annuelles (noms alignés sur le front + routes)
  heuresDues        : { type: Number, default: 0 },
  leconsPrevues     : { type: Number, default: 0 },
  leconsDigPrevues  : { type: Number, default: 0 },
  tpPrevus          : { type: Number, default: 0 },
  tpDigPrevus       : { type: Number, default: 0 },
  enseignantsPoste  : { type: Number, default: 0 }
}, { timestamps: true });

BaselineSchema.index(
  { etablissement:1, annee:1, cycle:1, specialite:1, classe:1, discipline:1 },
  { unique:true }
);

module.exports = mongoose.models.Baseline || mongoose.model('Baseline', BaselineSchema);


