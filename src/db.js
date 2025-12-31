// src/db.js
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing env: DATABASE_URL");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parties (
      message_id  TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      guild_id    TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,      -- 'GAME'|'MOVIE'|'CHAT'|'MUSIC'
      title       TEXT NOT NULL,      -- GAME/MOVIE는 필수, CHAT/MUSIC는 '' 가능
      party_note  TEXT DEFAULT '',
      time_text   TEXT DEFAULT '',    -- ✅ 시간은 문자열 저장
      status      TEXT NOT NULL,      -- 'RECRUIT' | 'PLAYING' | 'ENDED'
      max_players INT  NOT NULL DEFAULT 4,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 기존 테이블에 time_text 없던 경우 대비(안전)
  await pool.query(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS time_text TEXT DEFAULT ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS party_members (
      message_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      note       TEXT DEFAULT '',
      joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    );
  `);
}

async function upsertParty(party) {
  const {
    message_id,
    channel_id,
    guild_id,
    owner_id,
    kind,
    title,
    party_note = "",
    time_text = "",
    status = "RECRUIT",
    max_players = 4,
  } = party;

  await pool.query(
    `
    INSERT INTO parties (message_id, channel_id, guild_id, owner_id, kind, title, party_note, time_text, status, max_players)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (message_id) DO UPDATE SET
      channel_id  = EXCLUDED.channel_id,
      guild_id    = EXCLUDED.guild_id,
      owner_id    = EXCLUDED.owner_id,
      kind        = EXCLUDED.kind,
      title       = EXCLUDED.title,
      party_note  = EXCLUDED.party_note,
      time_text   = EXCLUDED.time_text,
      status      = EXCLUDED.status,
      max_players = EXCLUDED.max_players
    `,
    [message_id, channel_id, guild_id, owner_id, kind, title, party_note, time_text, status, max_players]
  );
}

async function setMemberNote(messageId, userId, note = "") {
  await pool.query(
    `
    INSERT INTO party_members (message_id, user_id, note)
    VALUES ($1,$2,$3)
    ON CONFLICT (message_id, user_id) DO UPDATE SET
      note = EXCLUDED.note
    `,
    [messageId, userId, note]
  );
}

async function removeMember(messageId, userId) {
  await pool.query(`DELETE FROM party_members WHERE message_id=$1 AND user_id=$2`, [messageId, userId]);
}

async function deleteParty(messageId) {
  await pool.query(`DELETE FROM party_members WHERE message_id=$1`, [messageId]);
  await pool.query(`DELETE FROM parties WHERE message_id=$1`, [messageId]);
}

async function getParty(messageId) {
  const p = await pool.query(`SELECT * FROM parties WHERE message_id=$1`, [messageId]);
  if (!p.rows.length) return null;

  const m = await pool.query(
    `SELECT user_id, note FROM party_members WHERE message_id=$1 ORDER BY joined_at ASC`,
    [messageId]
  );

  return { ...p.rows[0], members: m.rows };
}

module.exports = {
  initDb,          // ✅ 이게 반드시 있어야 함
  upsertParty,
  getParty,
  setMemberNote,
  removeMember,
  deleteParty,
};
