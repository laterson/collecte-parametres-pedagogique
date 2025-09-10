// models/User.js
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');

const userSchema = new mongoose.Schema({
  nomComplet      : String,
  email           : { type:String, unique:true, lowercase:true, trim:true },
  etablissement   : { type:String, trim:true },
  etablissementId : { type: mongoose.Schema.Types.ObjectId, ref: 'School', index: true, sparse: true },
  departement     : { type:String, trim:true, default:'' },
  departementCode : { type:String, trim:true, default:'' },
  role            : { type:String, enum:['admin','anim','insp'], default:'anim', index:true },
  inspection      : { type:String, default:'artsplastiques', index:true, lowercase:true, trim:true },
  specialite      : { type:String, default:'', trim:true },
  passwordHash    : { type:String, default:'' }
}, { timestamps:true });

userSchema.methods.verifyPassword = function (pw) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(pw, this.passwordHash);
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
