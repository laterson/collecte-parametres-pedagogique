// scripts/cleanup_settings.js
// Usage: node scripts/cleanup_settings.js "mongodb://localhost:27017/fiches"

const mongoose = require('mongoose');

async function run() {
  const uri = process.argv[2] || 'mongodb://localhost:27017/fiches';
  const conn = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5000,
  }).asPromise();

  const coll = conn.collection('settings');

  const sameKey = (a, b) => {
    const ak = JSON.stringify(a || {});
    const bk = JSON.stringify(b || {});
    return ak === bk;
  };

  console.log('Connected ✔');

  // 1) Drop ancien index "etablissement_1_annee_1" si présent
  try { await coll.dropIndex('etablissement_1_annee_1'); console.log('Dropped old index etablissement_1_annee_1'); } catch {}

  // 2) Normalisation
  await coll.updateMany({ inspection: { $exists: false } }, { $set: { inspection: 'artsplastiques' } });
  await coll.updateMany({}, [{ $set: { inspection: { $toLower: '$inspection' } } }]);
  await coll.updateMany({}, [
    { $set: {
        etablissement: { $trim: { input: '$etablissement' } },
        annee: { $trim: { input: '$annee' } }
    } }
  ]);
  console.log('Normalized ✔');

  // 3) Déduplication (conserver le plus récent)
  const cursor = coll.aggregate([
    { $group: {
        _id: { inspection:'$inspection', etablissement:'$etablissement', annee:'$annee' },
        docs: { $push: { _id:'$_id', createdAt:'$createdAt' } },
        n: { $sum: 1 }
    }},
    { $match: { n: { $gt: 1 } } }
  ]);
  let removed = 0;
  for await (const g of cursor) {
    g.docs.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    const toDelete = g.docs.slice(1).map(d=>d._id);
    if (toDelete.length) removed += (await coll.deleteMany({ _id: { $in: toDelete } })).deletedCount || 0;
  }
  console.log(`Dedup removed: ${removed}`);

  // 4) Assurer l’index unique {inspection, etablissement, annee}
  const desiredKey = { inspection:1, etablissement:1, annee:1 };
  const idxs = await coll.indexes();
  const existing = idxs.find(i => sameKey(i.key, desiredKey));

  if (existing) {
    // Si l’index existe déjà avec la même clé :
    if (existing.unique) {
      console.log(`Index already exists (${existing.name}) and is unique ✔ — nothing to do`);
    } else {
      console.log(`Index ${existing.name} exists but is NOT unique → recreating as unique…`);
      await coll.dropIndex(existing.name);
      await coll.createIndex(desiredKey, { unique:true, name:'uniq_insp_etab_annee' });
      console.log('Recreated unique index ✔');
    }
  } else {
    // Aucun index avec cette clé → on le crée
    await coll.createIndex(desiredKey, { unique:true, name:'uniq_insp_etab_annee' });
    console.log('Created unique index ✔');
  }

  await conn.close();
  console.log('Done ✅');
}

run().catch(e => { console.error('Cleanup failed:', e); process.exit(1); });
