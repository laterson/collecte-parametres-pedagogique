// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const UserSchema = new mongoose.Schema({
  nomComplet      : { type: String, required: true, trim: true },

  // email unique, normalisé
  email           : { type: String, required: true, unique: true, lowercase: true, trim: true },

  etablissement   : { type: String, trim: true, default: '' },
  etablissementId : { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true, sparse: true },

  departement     : { type: String, trim: true, default: '' },
  departementCode : { type: String, trim: true, default: '' },

  role            : { type: String, enum: ['admin','anim','insp'], default: 'anim', index: true },

  // inspection normalisée
  inspection      : { type: String, default: 'artsplastiques', lowercase: true, trim: true, index: true },

  specialite      : { type: String, default: '', trim: true },

  passwordHash    : { type: String, required: true, default: '' }
}, { timestamps: true });

// Index (garde-fou)
UserSchema.index({ email: 1 }, { unique: true });

// Normalisation supplémentaire avant save (défense en profondeur)
UserSchema.pre('save', function(next){
  if (this.email)      this.email      = String(this.email).trim().toLowerCase();
  if (this.inspection) this.inspection = String(this.inspection).trim().toLowerCase();
  next();
});

// Vérification du mot de passe
UserSchema.methods.verifyPassword = function (pw) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(pw || ''), this.passwordHash);
};

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
