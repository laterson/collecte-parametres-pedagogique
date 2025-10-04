// db/chat.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
const db = new Database(path.join(process.cwd(), 'data', 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  room           TEXT NOT NULL,
  author_id      TEXT,
  author_name    TEXT NOT NULL,
  text           TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  client_msg_id  TEXT,
  reply_to_id    TEXT,
  reply_to_from  TEXT,
  reply_to_text  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_room_client
  ON messages(room, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_room_ts ON messages(room, ts DESC);
`);

const insertMsg   = db.prepare(`
  INSERT OR IGNORE INTO messages
  (room, author_id, author_name, text, ts, client_msg_id,
   reply_to_id, reply_to_from, reply_to_text)
  VALUES (@room, @author_id, @author_name, @text, @ts, @client_msg_id,
          @reply_to_id, @reply_to_from, @reply_to_text)
`);
const getById     = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const getByClient = db.prepare(`SELECT * FROM messages WHERE room = ? AND client_msg_id = ?`);
const lastNAsc    = db.prepare(`
  SELECT id, room, author_name AS "from", text, ts,
         reply_to_id, reply_to_from, reply_to_text
  FROM (SELECT * FROM messages WHERE room = ? ORDER BY ts DESC LIMIT ?) 
  ORDER BY ts ASC
`);
const delByRoom   = db.prepare(`DELETE FROM messages WHERE room = ?`);

module.exports = {
  insert(msg){ return insertMsg.run(msg); },
  getById(id){ return getById.get(id); },
  getByClient(room, cmid){ return getByClient.get(room, cmid); },
  listLast(room, limit=200){ return lastNAsc.all(room, limit); },
  clearRoom(room){ return delByRoom.run(room); } // 👈 AJOUT
};
