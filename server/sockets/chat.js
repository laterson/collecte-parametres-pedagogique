// server/sockets/chat.js
// Chat temps réel : essaie d'utiliser le store SQLite (better-sqlite3),
// sinon bascule sur un store en mémoire (pour Render).

let chatStore;
try {
  // tente le vrai store persistant (nécessite better-sqlite3)
  chatStore = require('../../db/chat'); // ← garde ce chemin si c'est le bon chez toi
} catch (e) {
  console.warn('Chat store disabled (better-sqlite3 not available):', e.message);

  // ---- Fallback mémoire, mêmes méthodes que db/chat.js ----
  const mem = new Map();      // room -> [rows]
  let gid = 1;                // id auto-incrément pour getById

  function ensure(room) {
    if (!mem.has(room)) mem.set(room, []);
    return mem.get(room);
  }

  chatStore = {
    insert(data) {
      // Simule INSERT OR IGNORE sur client_msg_id
      if (data.client_msg_id) {
        const dup = ensure(data.room).find(r => r.client_msg_id === data.client_msg_id);
        if (dup) return { changes: 0, lastInsertRowid: dup.id };
      }
      const row = {
        id: gid++,
        room: data.room,
        author_name: data.author_name || '—',
        text: String(data.text || ''),
        ts: Number(data.ts) || Date.now(),
        client_msg_id: data.client_msg_id || null,
        reply_to_id: data.reply_to_id || null,
        reply_to_from: data.reply_to_from || null,
        reply_to_text: data.reply_to_text || null,
      };
      ensure(data.room).push(row);
      return { changes: 1, lastInsertRowid: row.id };
    },

    getById(id) {
      for (const arr of mem.values()) {
        const r = arr.find(x => x.id === id);
        if (r) return r;
      }
      return null;
    },

    getByClient(room, client_msg_id) {
      return ensure(room).find(r => r.client_msg_id === client_msg_id) || null;
    },

    listLast(room, limit = 200) {
      const arr = ensure(room);
      return arr.slice(Math.max(0, arr.length - limit));
    },

    clearRoom(room) {
      mem.delete(room);
    }
  };
}

// clé unique du salon par inspection
const roomKey = (insp) => `insp:${String(insp || 'artsplastiques').toLowerCase()}`;


function attachChat(io) {
  // suivi présence : room -> Set(socketId)
  const ROOMS = new Map();
  const ensureSet = (key) => {
    if (!ROOMS.has(key)) ROOMS.set(key, new Set());
    return ROOMS.get(key);
  };

  io.on('connection', (socket) => {
    // infos utilisateur fournies par le client socket.io (auth.user)
    const u = socket.handshake?.auth?.user || {};
    socket.data.user = {
      id:         String(u.id || ''),
      nom:        String(u.nom || '—'),
      etab:       String(u.etab || ''),
      role:       String(u.role || 'anim'),
      inspection: String(u.inspection || 'artsplastiques'),
    };

    // ===== Rejoindre un salon & envoyer l'historique =====
    socket.on('chat:join', (payload = {}) => {
      const insp = String(payload.inspection || socket.data.user.inspection || '').toLowerCase();
      const key  = roomKey(insp);

      socket.join(key);
      ensureSet(key).add(socket.id);

      // historique persistant (limité à 200)
      // db/chat.listLast renvoie déjà {id, from, text, ts, reply_to_*}
      const history = chatStore.listLast(key, 200).map((row) => ({
        id:  row.id,
        from: row.from ?? row.author_name,   // compat selon SELECT
        text: row.text,
        ts:   row.ts,
        ...(row.reply_to_id || row.reply_to_text
            ? { replyTo: { id: row.reply_to_id, from: row.reply_to_from, text: row.reply_to_text } }
            : {}),
      }));
      socket.emit('chat:history', history);

      // présence
      io.to(key).emit('presence:update', ensureSet(key).size);
    });

    // ===== Déconnexion → maj présence =====
    socket.on('disconnect', () => {
      ROOMS.forEach((set, key) => {
        if (set.delete(socket.id)) {
          io.to(key).emit('presence:update', set.size);
        }
      });
    });

    // ===== Indicateur "X écrit…" =====
    socket.on('chat:typing', (p = {}) => {
      const insp = String(p.inspection || socket.data.user.inspection || '').toLowerCase();
      const key  = roomKey(insp);
      socket.to(key).emit('chat:typing', {
        from: socket.data.user.nom,
        typing: !!p.typing,
      });
    });

    // ===== Envoi d’un message =====
    socket.on('chat:send', (p = {}, ack) => {
      try {
        const insp = String(p.inspection || socket.data.user.inspection || '').toLowerCase();
        const key  = roomKey(insp);

        const rawText = String(p.text || '');
        const text    = rawText.slice(0, 5000).trim();
        if (!text) {
          ack && ack({ error: 'empty_message' });
          return;
        }

        // enregistrement en base (dédoublonné par client_msg_id)
        const toStore = {
          room:          key,
          author_id:     socket.data.user.id || null,
          author_name:   socket.data.user.nom,
          text,
          ts:            Number(p.ts) || Date.now(),
          client_msg_id: p.client_msg_id || null,
          reply_to_id:   p?.replyTo?.id   || null,
          reply_to_from: p?.replyTo?.from || null,
          reply_to_text: p?.replyTo?.text || null,
        };

        const info = chatStore.insert(toStore);

        // on relit la ligne (insertée ou existante si IGNORE)
        let row = null;
        if (info && info.changes > 0) {
          row = chatStore.getById(info.lastInsertRowid);
        } else if (toStore.client_msg_id) {
          row = chatStore.getByClient(key, toStore.client_msg_id);
        }
        if (!row) throw new Error('insert_failed');

        const out = {
          id:  row.id,
          from: row.author_name || socket.data.user.nom,
          text: row.text,
          ts:   row.ts,
          ...(row.reply_to_id || row.reply_to_text
              ? { replyTo: { id: row.reply_to_id, from: row.reply_to_from, text: row.reply_to_text } }
              : {}),
        };

        io.to(key).emit('chat:new', out);
        ack && ack({ ok: true, id: out.id });
      } catch (e) {
        socket.emit('chat:error', { message: e?.message || 'send_failed' });
        ack && ack({ error: e?.message || 'send_failed' });
      }
    });
  });
}

/**
 * Purge programmée depuis une route HTTP (ex: /api/chat/reset)
 * Efface l’historique SQLite de l’inspection et notifie les clients.
 * Utilisation côté server.js :
 *   const attachChat = require('./server/sockets/chat');
 *   ...
 *   attachChat.purge(io, inspectionString);
 */
attachChat.purge = function purge(io, inspection) {
  const key  = roomKey(inspection);
  try { chatStore.clearRoom(key); } catch (_) {}
  try { io.to(key).emit('chat:history', []); } catch (_) {}
};

module.exports = attachChat;
