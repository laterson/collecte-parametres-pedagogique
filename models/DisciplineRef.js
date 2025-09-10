// models/DisciplineRef.js
const mongoose = require('mongoose');

const DisciplineRefSchema = new mongoose.Schema({
  // ==== Scope ====
  inspection : { type:String, required:true, index:true }, // ex: 'ARTS', 'MATH'

  // ==== Clé & libellé ====
  code       : { type:String, required:true },             // unique dans une inspection
  nom        : { type:String, required:true, trim:true },

  // ==== Rattachements ====
  cycle      : { type:String, enum:['premier','second'], required:true },
  specialite : { type:String, required:true },             // DECO, AF1, AF2, ...

  // ==== Gestion ====
  actif      : { type:Boolean, default:true },
  ordre      : { type:Number, default:0 },                 // pour l’affichage
  aliases    : [{ type:String, trim:true }],
}, { timestamps:true });

// Unicité du code dans une inspection
DisciplineRefSchema.index({ inspection:1, code:1 }, { unique:true });
// Listing rapide
DisciplineRefSchema.index({ inspection:1, cycle:1, specialite:1, actif:1, ordre:1 });

module.exports = mongoose.models.DisciplineRef || mongoose.model('DisciplineRef', DisciplineRefSchema);
