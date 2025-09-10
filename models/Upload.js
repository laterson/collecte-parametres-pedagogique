// models/Upload.js
const mongoose = require('mongoose');

const uploadSchema = new mongoose.Schema({
  name        : { type:String, required:true, trim:true },
  size        : { type:Number, default:0 },
  path        : { type:String, required:true },              // ex: uploads/17123456_doc.pdf

  // Contexte de partage
  inspection  : { type:String, required:true, index:true, lowercase:true, trim:true },
  etablissement: { type:String, default:'', index:true },
  departement : { type:String, default:'', index:true },
  annee       : { type:String, default:'' },                 // optionnel si tu veux filtrer par année

  // Propriétaire
  ownerId     : { type: mongoose.Schema.Types.ObjectId, ref:'User', index:true },
  ownerName   : { type:String, default:'' },
  ownerRole   : { type:String, enum:['admin','anim','insp'], default:'anim' },
}, { timestamps:true });

module.exports = mongoose.models.Upload || mongoose.model('Upload', uploadSchema);
