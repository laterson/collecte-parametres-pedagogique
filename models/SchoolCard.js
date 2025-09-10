// models/SchoolCard.js
const mongoose = require('mongoose');

const DiscSchema = new mongoose.Schema({
  nom: String,
  heuresDues: Number, heuresFaites: Number,
  leconsPrevues: Number, leconsFaites: Number,
  leconsDigPrevues: Number, leconsDigFaites: Number,
  tpPrevus: Number, tpFaits: Number,
  tpDigPrevus: Number, tpDigFaits: Number,
  elevesComposants: Number, elevesMoySup10: Number,
  ensTotal: Number, ensPoste: Number
}, { _id:false });

const ClassSchema = new mongoose.Schema({
  nom: String,
  disciplines: [DiscSchema]
}, { _id:false });

const SchoolCardSchema = new mongoose.Schema({
  meta: {
    inspection: { type:String, required:true },
    etablissement: { type:String, required:true },
    animateur: String,
    departement: String,     
    annee: String,
    cycle: String,
    specialite: String,
    evaluation: Number,
    generatedAt: Date
  },
  effectifs: [{ classe:String, filles:Number, garcons:Number }],
  staff: [{
    nom:String, grade:String, matiere:String, statut:String, obs:String,
    classes:[String], disciplines:[String]
  }],
  classes: [ClassSchema],
  version: Number,
  fingerprint: String,
  prevFingerprint: String,
  receivedAt: Date,
  updatedAt: Date
}, { timestamps:true });

module.exports = mongoose.model('SchoolCard', SchoolCardSchema);
