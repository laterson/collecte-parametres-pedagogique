// seedAdmin.js — crée / met à jour le super-admin sans arrêter l’appli
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcrypt');
const User     = require('./models/User');

async function seedSuperAdmin () {
  await mongoose.connect(process.env.MONGODB_URI);

  /* Super-admin déjà présent ? */
  const admin = await User.findOne({ role: 'admin' });

  /* S’il existe, on met juste à jour son mot de passe si la variable .env a changé  */
  if (admin) {
    if (process.env.ADMIN_PASSWORD) {
      const same = await bcrypt.compare(process.env.ADMIN_PASSWORD, admin.passwordHash);
      if (!same) {
        admin.passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        await admin.save();
        console.log('🔑 Mot de passe admin mis à jour');
      } else {
        console.log('✅ Admin déjà présent, mot de passe inchangé');
      }
    }
    return;
  }

  /* Sinon on le crée */
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('⛔  ADMIN_EMAIL ou ADMIN_PASSWORD manquant dans .env');
    return;
  }

  await User.create({
    nomComplet   : 'Super Administrateur',
    email        : ADMIN_EMAIL,
    etablissement: 'Direction Régionale',
    role         : 'admin',
    passwordHash : await bcrypt.hash(ADMIN_PASSWORD, 12)
  });

  console.log('🎉 Super-admin créé avec succès');
}

module.exports = seedSuperAdmin;



