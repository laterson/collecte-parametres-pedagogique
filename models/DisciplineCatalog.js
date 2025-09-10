// models/DisciplineCatalog.js
const mongoose = require('mongoose');

const DisciplineCatalogSchema = new mongoose.Schema({
  inspection: { type:String, required:true, trim:true, lowercase:true, index:true }, // "artsplastiques", "maths"...
  cycle     : { type:String, enum:['premier','second'], required:true, index:true },
  specialite: { type:String, required:true, trim:true, uppercase:true, index:true }, // "DECO", "AF2", ...
  code      : { type:String, required:true, trim:true, uppercase:true },             // unique par inspection
  nom       : { type:String, required:true, trim:true },
  actif     : { type:Boolean, default:true, index:true },
  ordre     : { type:Number, default:0 },
  aliases   : [{ type:String, trim:true }]
},{ timestamps:true });

DisciplineCatalogSchema.index({ inspection:1, code:1 }, { unique:true });
DisciplineCatalogSchema.index({ inspection:1, cycle:1, specialite:1, actif:1, ordre:1 });

module.exports = mongoose.models.DisciplineCatalog
  || mongoose.model('DisciplineCatalog', DisciplineCatalogSchema);
