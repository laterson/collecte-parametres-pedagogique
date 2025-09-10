const mongoose = require('mongoose');

/* ---------- Sub-schemas ---------- */
const DisciplineSchema = new mongoose.Schema({
  nom:   { type:String, trim:true },

  // Heures
  hD:    { type:Number, default:0 },
  hF:    { type:Number, default:0 },

  // Leçons (cours)
  lp:    { type:Number, default:0 },
  lf:    { type:Number, default:0 },
  ldp:   { type:Number, default:0 },
  ldf:   { type:Number, default:0 },

  // TP
  tp:    { type:Number, default:0 },
  tf:    { type:Number, default:0 },
  tdp:   { type:Number, default:0 },
  tdf:   { type:Number, default:0 },

  // Compétences / Moyenne 10 / Effectifs
  comp:  { type:Number, default:0 },
  m10:   { type:Number, default:0 },
  effTot:{ type:Number, default:0 },
  effPos:{ type:Number, default:0 }
},{ _id:false });

const ClasseSchema = new mongoose.Schema({
  nom:         { type:String, trim:true },
  // ← ajout pour persister les effectifs au niveau classe
  filles:      { type:Number, default:0 },
  garcons:     { type:Number, default:0 },
  disciplines: [DisciplineSchema]
},{ _id:false });

const EffectifSchema = new mongoose.Schema({
  classe:  { type:String, trim:true },
  filles:  { type:Number, default:0 },
  garcons: { type:Number, default:0 }
},{ _id:false });

const StaffSchema = new mongoose.Schema({
  nom:     { type:String, trim:true },
  grade:   { type:String, trim:true },
  matiere: { type:String, trim:true },
  statut:  { type:String, trim:true },
  obs:     { type:String, trim:true },
  // ← ajouts pour conserver le “fichier complet” (affectations)
  classes:     [{ type:String, trim:true }],
  disciplines: [{ type:String, trim:true }]
},{ _id:false });

/* ---------- Main schema ---------- */
const CollecteSchema = new mongoose.Schema({
  // Multi-inspections
  inspection   : { type:String, default:'artsplastiques', index:true },

  // Période
  annee        : { type:String, trim:true }, // ex "2025-2026"
  evaluation   : { type:Number, min:1, max:6, required:true },

  // Périmètre pédagogique
  cycle        : { type:String, enum:['premier','second'], required:true },
  specialite   : { type:String, required:true, trim:true }, // laissé libre (catalogue externe)

  // Contexte dépôt
  etablissement: { type:String, trim:true },
  animateur    : { type:String, trim:true },
  departement  : { type:String, trim:true, default:'' },
  dateDepot    : { type:Date, default:Date.now },

  // Données
  classes      : [ClasseSchema],
  effectifs    : [EffectifSchema],
  staff        : [StaffSchema]
}, { timestamps:true });

/* ---------- Normalisation avant save ---------- */
CollecteSchema.pre('save', function(next){
  if (this.inspection) this.inspection = String(this.inspection).toLowerCase().trim();
  if (this.cycle)      this.cycle      = String(this.cycle).toLowerCase().trim();
  if (this.specialite) this.specialite = String(this.specialite).toUpperCase().trim();
  next();
});

/* ---------- Index utiles pour tes requêtes ---------- */
// Résumés: filtrage par (inspection, cycle, specialite, evaluation)
CollecteSchema.index({ inspection:1, cycle:1, specialite:1, evaluation:1 });
// Liste “mes collectes” triées par date
CollecteSchema.index({ animateur:1, dateDepot:-1 });
// Accès par établissement + période
CollecteSchema.index({ etablissement:1, evaluation:1, dateDepot:-1 });

CollecteSchema.index({ inspection:1, etablissement:1, annee:1 });
CollecteSchema.index({ inspection:1, departement:1, annee:1 });


module.exports = mongoose.models.Collecte || mongoose.model('Collecte', CollecteSchema);
