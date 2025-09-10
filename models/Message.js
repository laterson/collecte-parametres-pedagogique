// models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  texte:        { type:String, required:true },
  auteurId:     { type:String, default:'' },
  auteurNom:    { type:String, default:'' },
  auteurRole:   { type:String, default:'' },
  inspection:   { type:String, index:true, lowercase:true, trim:true }, // cloisonnement
  etablissement:{ type:String, index:true, trim:true },
  replyTo: {
  id:   { type:String },
  from: { type:String },
  text: { type:String }
}

}, { timestamps:true }); // ← createdAt/updatedAt auto (utilisé par chat.js)

module.exports = mongoose.models.Message || mongoose.model('Message', MessageSchema);






