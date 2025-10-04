// models/Teacher.js
const mongoose = require('mongoose');

const TeacherSchema = new mongoose.Schema({
  // Clés de rattachement
  inspection      : { type:String, index:true, required:true, lowercase:true, trim:true },
  etablissement   : { type:String, index:true, required:true, trim:true },
  annee           : { type:String, index:true, required:true, trim:true },

  // En-tête d’organisation
  departement     : { type:String, index:true, default:'', trim:true },
  departementCode : { type:String, index:true, default:'', trim:true },
  specialite      : { type:String, index:true, default:'', uppercase:true, trim:true },
  cycle           : { type:String, index:true, enum:['premier','second',''], default:'', trim:true },

  // Identité / RH
  nom             : { type:String, required:true, trim:true },
  matricule       : { type:String, default:'', trim:true },
  grade           : { type:String, default:'', trim:true },
  categorie       : { type:String, default:'', trim:true },
  dateNaissance   : { type:Date,   default:null },
  sexe            : { type:String, default:'', trim:true },

  // Origines (optionnel)
  regionOrigine        : { type:String, default:'', trim:true },
  departementOrigine   : { type:String, default:'', trim:true },
  arrondissementOrigine: { type:String, default:'', trim:true },

  // Parcours
  dateEntreeFP     : { type:Date,   default:null },
  posteOccupe      : { type:String, default:'', trim:true },
  dateAffectation  : { type:Date,   default:null },
  rangPoste        : { type:String, default:'', trim:true },
  telephone        : { type:String, default:'', trim:true },

  // Pédagogie locale
  matiere       : { type:String, default:'', trim:true },
  statut        : { type:String, default:'Enseignant', trim:true },
  classes       : { type:[String], default:[] },
  disciplines   : { type:[String], default:[] },
  observations  : { type:String, default:'', trim:true },

  createdBy     : { type:String, default:'' },
}, { timestamps:true });

// Unicité par enseignant dans l’établissement sur une année
TeacherSchema.index({ inspection:1, etablissement:1, annee:1, nom:1 }, { unique:true });

// Petites normalisations
TeacherSchema.pre('save', function(next){
  if (this.specialite) this.specialite = String(this.specialite).toUpperCase().trim();
  if (this.departement) this.departement = String(this.departement).trim();
  next();
});

module.exports = mongoose.models.Teacher || mongoose.model('Teacher', TeacherSchema);
