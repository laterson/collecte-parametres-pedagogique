// models/InspDefaults.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const InspDefaultsSchema = new Schema({
  inspection : { type:String, required:true, lowercase:true, index:true },
  cycle      : { type:String, enum:['premier','second'], required:true },
  specialite : { type:String, required:true, uppercase:true },
  classes    : [String],   // ex: ['2nde AF1', '1ère AF1', 'Tle AF1']
  disciplines: [String]    // optionnel: si tu veux aussi lister des modules “attendus”
}, { timestamps:true });

InspDefaultsSchema.index({ inspection:1, cycle:1, specialite:1 }, { unique:true });

module.exports = mongoose.models.InspDefaults
  || mongoose.model('InspDefaults', InspDefaultsSchema);
