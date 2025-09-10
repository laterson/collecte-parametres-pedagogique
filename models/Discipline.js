// models/Discipline.js
const mongoose = require('mongoose');

const DisciplineSchema = new mongoose.Schema({
  code:       { type:String, required:true, unique:true, trim:true, uppercase:true },
  cycle:      { type:String, enum:['premier','second'], required:true, index:true },
  specialite: { type:String, required:true, index:true }, // ex: DECO, AF1, AF2, AF3
  nom:        { type:String, required:true, trim:true },  // libellé affiché
  actif:      { type:Boolean, default:true, index:true },
  ordre:      { type:Number, default:1000 },
  aliases:    [{ type:String, trim:true }]
}, { timestamps:true });

DisciplineSchema.index({ cycle:1, specialite:1, actif:1, ordre:1, nom:1 });

DisciplineSchema.statics.bySpec = function(cycle, specialite, onlyActive=true){
  const q = { cycle, specialite };
  if (onlyActive) q.actif = true;
  return this.find(q).sort({ ordre:1, nom:1 }).lean();
};

module.exports = mongoose.models.Discipline || mongoose.model('Discipline', DisciplineSchema);
