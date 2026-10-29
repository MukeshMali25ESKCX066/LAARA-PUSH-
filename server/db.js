// libSQL client: works with a local file (dev) or Turso (Vercel / production).
const path = require('path');
const fs = require('fs');

let url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').trim() || undefined;
let createClient;
if (!url) {
  if (process.env.VERCEL) throw new Error('TURSO_DATABASE_URL is not set. Add it in Vercel -> Settings -> Environment Variables, then Redeploy.');
  const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dir, { recursive: true });
  url = 'file:' + path.join(dir, 'pushdesk.db');
  ({ createClient } = require('@libsql/client'));
} else if (url.startsWith('file:')) {
  ({ createClient } = require('@libsql/client'));
} else {
  // Remote Turso: use the pure-HTTP client (no native binaries, safest on serverless)
  url = url.replace(/^libsql:\/\//, 'https://');
  ({ createClient } = require('@libsql/client/web'));
}
const client = createClient({ url, authToken });

const plain = (rows) => rows.map((r) => ({ ...r }));
async function all(sql, args = []) { return plain((await client.execute({ sql, args })).rows); }
async function get(sql, args = []) { return (await all(sql, args))[0]; }
async function run(sql, args = []) {
  const r = await client.execute({ sql, args });
  return { changes: r.rowsAffected, id: Number(r.lastInsertRowid || 0) };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  domain TEXT,
  site_key TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  browser TEXT, os TEXT, device TEXT, country TEXT, language TEXT, page TEXT,
  permission TEXT DEFAULT 'granted',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id, endpoint)
)`,
  `CREATE INDEX IF NOT EXISTS idx_sub_site ON subscribers(site_id, active)`,
  `CREATE TABLE IF NOT EXISTS email_subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  source TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id, email)
)`,
  `CREATE INDEX IF NOT EXISTS idx_email_sub_site ON email_subscribers(site_id, active)`,
  `CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT, url TEXT, icon TEXT, image TEXT,
  segment TEXT DEFAULT '{}',
  status TEXT DEFAULT 'sending',
  total INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`,
  `CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, icon TEXT, image TEXT
)`
];
async function initDb() {
  await client.batch(SCHEMA, 'write');
  let columns = await all('PRAGMA table_info(campaigns)');
  if (!columns.some((column) => column.name === 'scheduled_at')) {
    try { await run('ALTER TABLE campaigns ADD COLUMN scheduled_at INTEGER'); }
    catch (error) {
      columns = await all('PRAGMA table_info(campaigns)');
      if (!columns.some((column) => column.name === 'scheduled_at')) throw error;
    }
  }
  columns = await all('PRAGMA table_info(campaigns)');
  if (!columns.some((column) => column.name === 'action_label')) {
    await run('ALTER TABLE campaigns ADD COLUMN action_label TEXT DEFAULT \'\'');
  }
  await run('CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON campaigns(status, scheduled_at)');
  columns = await all('PRAGMA table_info(subscribers)');
  if (!columns.some((column) => column.name === 'permission')) {
    await run("ALTER TABLE subscribers ADD COLUMN permission TEXT DEFAULT 'granted'");
  }
}

// Race-safe "create once" setting (several serverless instances may boot together).
async function ensureSetting(key, makeValue) {
  let r = await get('SELECT value FROM settings WHERE key=?', [key]);
  if (r) return r.value;
  await run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', [key, makeValue()]);
  return (await get('SELECT value FROM settings WHERE key=?', [key])).value;
}

async function diagnose() {
  const rawUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  const d = {
    urlSet: !!rawUrl,
    urlScheme: (rawUrl.match(/^[a-z]+:/i) || [''])[0],
    urlHasQuotesOrSpaces: /["'\s]/.test(process.env.TURSO_DATABASE_URL || '') && /["']/.test(process.env.TURSO_DATABASE_URL || ''),
    urlHasPathOrQuery: /^[a-z]+:\/\/[^/?]+[/?]./i.test(rawUrl),
    tokenSet: !!authToken,
    tokenLength: authToken ? authToken.length : 0,
    tokenStartsWithEyJ: authToken ? authToken.startsWith('eyJ') : false,
    tokenHasQuotes: /["']/.test(process.env.TURSO_AUTH_TOKEN || '')
  };
  try { await client.execute('SELECT 1'); d.select1 = 'ok'; }
  catch (e) { d.select1 = String((e && e.message) || e).slice(0, 200); }
  return d;
}

module.exports = { all, get, run, initDb, ensureSetting, diagnose };
