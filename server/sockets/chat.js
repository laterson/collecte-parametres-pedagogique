// server/sockets/chat.js
// Chat temps réel "type WhatsApp" — version PERSISTANTE (SQLite).
// On garde salons/presence/typing ; l'historique est stocké en base.

const chatStore = require('../../db/chat'); // adapte le chemin si besoin

module.exports = function attachChat(io) {
  // Set pour la présence (par salon)
  const ROOMS = new Map(); // room -> Set(socketId)

  const roomKey = (inspection) => `insp:${String(inspection || 'artsplastiques').toLowerCase()}`;
  const ensureSet = (key) => { if (!ROOMS.has(key)) ROOMS.set(key, new Set()); return ROOMS.get(key); };

  io.on('connection', (socket) => {
    // Infos utilisateur passées par socket.io client: auth.user
    const u = socket.handshake?.auth?.user || {};
    socket.data.user = {
      nom: String(u.nom || '—'),
      etab: String(u.etab || ''),
      role: String(u.role || 'anim'),
      inspection: String(u.inspection || 'artsplastiques'),
    };

    // Rejoindre le salon de l'inspection
    socket.on('chat:join', (payload = {}) => {
      const insp = String(payload.inspection || socket.data.user.inspection || '').toLowerCase();
      const key = roomKey(insp);

      socket.join(key);
      ensureSet(key).add(socket.id);

      // Historique persistant
      const history = chatStore.listLast(key, 200).map(row => ({
        id: row.id,
        from: row.from,
        text: row.text,
        ts: row.ts,
        ...(row.reply_to_id || row.reply_to_text ? {
          replyTo: { id: row.reply_to_id, from: row.reply_to_from, text: row.reply_to_text }
        } : {})
      }));
      socket.emit('chat:history', history);

      // Présence
      io.to(key).emit('presence:update', ensureSet(key).size);
    });

    // Déconnexion → présence
    socket.on('disconnect', () => {
      ROOMS.forEach((set, key) => {
        if (set.delete(socket.id)) {
          io.to(key).emit('presence:update', set.size);
        }
      });
    });

    // Indicateur "X écrit…"
    socket.on('chat:typing', (p = {}) => {
      const insp = String(p.inspection || socket.data.user.inspection || '').toLowerCase();
      const key = roomKey(insp);
      socket.to(key).emit('chat:typing', {
        from: socket.data.user.nom,
        typing: !!p.typing,
      });
    });

    // Envoi d’un message
    socket.on('chat:send', (p = {}, ack) => {
      try {
        const insp = String(p.inspection || socket.data.user.inspection || '').toLowerCase();
        const key = roomKey(insp);

        const msgToStore = {
          room: key,
          author_id:   u.id || null,
          author_name: socket.data.user.nom,
          text:        String(p.text || '').slice(0, 5000),
          ts:          Number(p.ts) || Date.now(),
          client_msg_id: p.client_msg_id || null,
          reply_to_id:   p.replyTo?.id   || null,
          reply_to_from: p.replyTo?.from || null,
          reply_to_text: p.replyTo?.text || null
        };

        const info = chatStore.insert(msgToStore);

        // Récupérer la ligne insérée (ou l'existante si doublon client_msg_id)
        let row;
        if (info.changes > 0) {
          row = chatStore.getById(info.lastInsertRowid);
        } else if (msgToStore.client_msg_id) {
          row = chatStore.getByClient(key, msgToStore.client_msg_id);
        }
        if (!row) throw new Error('insert_failed');

        const out = {
          id: row.id,
          from: row.author_name,
          text: row.text,
          ts: row.ts,
          ...(row.reply_to_id || row.reply_to_text ? {
            replyTo: { id: row.reply_to_id, from: row.reply_to_from, text: row.reply_to_text }
          } : {})
        };

        io.to(key).emit('chat:new', out);
        ack && ack({ ok: true, id: out.id });
      } catch (e) {
        socket.emit('chat:error', { message: e?.message || 'send failed' });
        ack && ack({ error: e?.message || 'send failed' });
      }
    });
  });
};
