// routes/messages.js
const express  = require('express');
const router   = express.Router();
const Message  = require('../models/Message');
const { requireAuth } = require('../server/middleware/auth');

const ROOM = insp => `chat:${String(insp||'artsplastiques').toLowerCase()}`;

router.use(requireAuth);

// Liste (JSON)
router.get('/', async (req, res) => {
  const room = ROOM(req.user.inspection);
  const list = await Message.find({ groupe: room }).sort({ ts:1 }).limit(500).lean();
  res.json(list);
});

// Création
router.post('/', async (req, res) => {
  const text = String(req.body?.text||'').trim();
  if(!text) return res.status(400).json({ error:'vide' });

  const room = ROOM(req.user.inspection);
  const m = await Message.create({
    groupe: room,
    from  : req.user.nom,
    role  : req.user.role,
    text,
    ts    : new Date()
  });

  // notifier en temps réel
  const io = req.app.get('io');
  if (io) io.to(room).emit('chat:new', {
    _id:String(m._id), from:m.from, role:m.role, text:m.text, ts:m.ts
  });

  res.status(201).json(m);
});

module.exports = router;
