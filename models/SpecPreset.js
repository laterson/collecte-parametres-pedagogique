// models/SpecPreset.js
const mongoose = require('mongoose');

const SpecPresetSchema = new mongoose.Schema(
  {
    inspection: { type: String, required: true, trim: true, lowercase:true },
    cycle     : { type: String, required: true, enum: ['premier', 'second'] },
    specialite: { type: String, required: true, trim: true, uppercase:true },
    classes   : { type: [String], default: [] },
  },
  { timestamps: true }
);

SpecPresetSchema.index({ inspection: 1, cycle: 1, specialite: 1 }, { unique: true });

module.exports = mongoose.models.SpecPreset || mongoose.model('SpecPreset', SpecPresetSchema);



