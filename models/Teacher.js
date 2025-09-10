// models/Teacher.js
const mongoose = require('mongoose');

const TeacherSchema = new mongoose.Schema({
  inspection   : { type:String, index:true, required:true, lowercase:true, trim:true },
  etablissement: { type:String, index:true, required:true, trim:true },
  annee        : { type:String, index:true, required:true, trim:true },
  nom          : { type:String, required:true, trim:true },
  grade        : { type:String, default:'', trim:true },
  matiere      : { type:String, default:'', trim:true },
  statut       : { type:String, default:'Enseignant', trim:true },
  classes      : { type:[String], default:[] },
  disciplines  : { type:[String], default:[] },
  observations : { type:String, default:'', trim:true },
  createdBy    : { type:String, default:'' },
}, { timestamps:true });

TeacherSchema.index({ inspection:1, etablissement:1, annee:1, nom:1 }, { unique:true });

module.exports = mongoose.models.Teacher || mongoose.model('Teacher', TeacherSchema);
