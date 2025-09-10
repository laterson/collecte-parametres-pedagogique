// models/Inspection.js
const mongoose = require('mongoose');

const InspectionSchema = new mongoose.Schema({
  key: { type:String, required:true, unique:true, lowercase:true, trim:true }, // ex: "artsplastiques"
  nom: { type:String, required:true, trim:true },                               // ex: "Arts plastiques"
  cyclesEnabled: {
    premier: { type:Boolean, default:true },
    second : { type:Boolean, default:true }
  }
}, { timestamps:true });

module.exports = mongoose.models.Inspection || mongoose.model('Inspection', InspectionSchema);



