// models/DisciplineSuggestion.js
const mongoose = require('mongoose');

const DisciplineSuggestionSchema = new mongoose.Schema({
  inspection  : { type:String, required:true, lowercase:true, index:true }, // ← pour router au bon IPR
  cycle       : { type:String, enum:['premier','second'], required:true },
  specialite  : { type:String, required:true },
  nom         : { type:String, required:true, trim:true }, // proposition de libellé
  motif       : { type:String, trim:true },
  fromUser    : { type:String },
  etablissement:{ type:String },
  status      : { type:String, enum:['pending','approved','rejected'], default:'pending', index:true },
  resolvedAt  : { type:Date }
}, { timestamps:true });

module.exports = mongoose.models.DisciplineSuggestion
  || mongoose.model('DisciplineSuggestion', DisciplineSuggestionSchema);

