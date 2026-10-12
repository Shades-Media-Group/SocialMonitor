import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

/** The repository's data/ folder: database, browser profile, media and reports. Git-ignored. */
export const DATA_DIR = resolve(
  process.env.SOCIALMONITOR_DATA ??
    join(dirname(fileURLToPath(import.meta.url)), '../../../../data'),
)

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  network TEXT NOT NULL CHECK (network IN ('instagram','facebook','tiktok')),
  url TEXT NOT NULL,
  handle TEXT NOT NULL,
  last_run_at TEXT,
  last_session_at TEXT,
  last_status TEXT,
  last_error TEXT,
  UNIQUE (brand_id, network)
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  url TEXT NOT NULL,
  posted_at TEXT,
  kind TEXT NOT NULL DEFAULT 'post',
  caption TEXT NOT NULL DEFAULT '',
  thumb_url TEXT,
  likes INTEGER,
  comments_count INTEGER,
  shares INTEGER,
  views INTEGER,
  description TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE (network, ext_id)
);
CREATE INDEX IF NOT EXISTS posts_profile ON posts(profile_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  ext_id TEXT NOT NULL,
  parent_ext_id TEXT,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  likes INTEGER,
  posted_at TEXT,
  fetched_at TEXT NOT NULL,
  label TEXT,
  needs_reply INTEGER,
  reason TEXT,
  UNIQUE (post_id, ext_id)
);
CREATE INDEX IF NOT EXISTS comments_label ON comments(label, needs_reply);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,
  scope TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  log TEXT NOT NULL DEFAULT '',
  stats TEXT,
  report TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('interval','times')),
  every_hours REAL,
  times TEXT NOT NULL DEFAULT '[]',
  networks TEXT NOT NULL,
  range TEXT NOT NULL DEFAULT 'new',
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type DB = DatabaseSync

export function openDb(file = join(DATA_DIR, 'socialmonitor.db')): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Columns added after a table first shipped. Each runs once, on databases that lack it. */
function migrate(db: DatabaseSync) {
  const has = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
      (c) => c.name === col,
    )
  if (!has('profiles', 'last_session_at'))
    db.exec('ALTER TABLE profiles ADD COLUMN last_session_at TEXT')
  // Where a comment that needs a reply stands: open until someone answers it on the network or skips it.
  if (!has('comments', 'reply_status'))
    db.exec("ALTER TABLE comments ADD COLUMN reply_status TEXT NOT NULL DEFAULT 'open'")
  // Positive or negative, and which kind, set by a person or by Claude. Empty until someone does.
  if (!has('comments', 'sentiment')) {
    db.exec('ALTER TABLE comments ADD COLUMN sentiment TEXT')
    db.exec('ALTER TABLE comments ADD COLUMN category TEXT')
    db.exec('ALTER TABLE comments ADD COLUMN sentiment_by TEXT')
  }
  // What the brand is: shown on its About page and given to the AI as context.
  if (!has('brands', 'industry')) {
    db.exec('ALTER TABLE brands ADD COLUMN industry TEXT')
    db.exec('ALTER TABLE brands ADD COLUMN description TEXT')
    db.exec('ALTER TABLE brands ADD COLUMN notes TEXT')
  }
  // Each brand's own positive and negative categories.
  if (!has('brands', 'categories'))
    db.exec("ALTER TABLE brands ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'")
}

export const now = () => new Date().toISOString()
