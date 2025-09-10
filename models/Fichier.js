// models/Fichier.js
const mongoose = require('mongoose');

const FichierSchema = new mongoose.Schema({
  inspection : { type:String, index:true },   // scope régional
  specialite : { type:String, default:'' },   // filtre éventuel
  evaluation : { type:Number, min:1, max:6 }, // optionnel
  categorie  : { type:String, default:'Autre' },
  description: { type:String, default:'' },

  // propriétaire / contexte
  ownerId    : { type: mongoose.Schema.Types.ObjectId, ref:'User' },
  ownerNom   : String,
  ownerRole  : { type:String, enum:['admin','anim','insp'] },
  etablissement: String,

  // fichier
  name       : String,    // nom original
  storedName : String,    // nom sur disque
  size       : Number,
  path       : String,    // chemin absolu
  url        : String,    // /uploads/<insp>/<storedName>
  scope      : { type:String, enum:['ap','insp'], default:'ap' }, // qui a publié
}, { timestamps:true });

FichierSchema.index({ inspection:1, specialite:1, scope:1, createdAt:-1 });

module.exports = mongoose.models.Fichier || mongoose.model('Fichier', FichierSchema);

