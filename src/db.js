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
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      party_note  TEXT DEFAULT '',
      mode        TEXT NOT NULL,
      start_at    BIGINT NOT NULL,
      status      TEXT NOT NULL,      -- 'RECRUIT' | 'PLAYING' | 'ENDED'
      max_players INT  NOT NULL DEFAULT 4,
      time_text   TEXT DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS party_members (
      message_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      note       TEXT DEFAULT '',
      joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    );
  `);

  // 기존 DB에 time_text 컬럼 없을 수 있어서 안전하게 추가
  await pool.query(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS time_text TEXT DEFAULT '';`);
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
    mode = "TEXT",
    start_at = 0,
    status = "RECRUIT",
    max_players = 4,
    time_text = "",
  } = party;

  await pool.query(
    `
    INSERT INTO parties (message_id, channel_id, guild_id, owner_id, kind, title, party_note, mode, start_at, status, max_players, time_text)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (message_id) DO UPDATE SET
      channel_id   = EXCLUDED.channel_id,
      guild_id     = EXCLUDED.guild_id,
      owner_id     = EXCLUDED.owner_id,
      kind         = EXCLUDED.kind,
      title        = EXCLUDED.title,
      party_note   = EXCLUDED.party_note,
      mode         = EXCLUDED.mode,
      start_at     = EXCLUDED.start_at,
      status       = EXCLUDED.status,
      max_players  = EXCLUDED.max_players,
      time_text    = EXCLUDED.time_text
    `,
    [
      message_id,
      channel_id,
      guild_id,
      owner_id,
      kind,
      title,
      party_note,
      mode,
      start_at,
      status,
      max_players,
      time_text,
    ]
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

// ✅ index.js가 기대하는 함수 (재시작 후 싱크용)
async function listActiveParties() {
  const r = await pool.query(`SELECT message_id FROM parties WHERE status <> 'ENDED' ORDER BY created_at DESC`);
  return r.rows.map((x) => x.message_id);
}

module.exports = {
  initDb,
  upsertParty,
  getParty,
  setMemberNote,
  removeMember,
  deleteParty,
  listActiveParties,
};
