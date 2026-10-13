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

-- A brand's own account, connected through the network's official sign-in.
CREATE TABLE IF NOT EXISTS network_tokens (
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  network TEXT NOT NULL,
  open_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  scope TEXT NOT NULL,
  account TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  PRIMARY KEY (brand_id, network)
);

-- Each post's numbers over time: a row whenever a read found them changed.
CREATE TABLE IF NOT EXISTS post_metrics (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  views INTEGER,
  PRIMARY KEY (post_id, at)
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

-- Every report and export someone generated, kept as a file under data/reports/ to open again.
CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

-- People who can open the dashboard. A super admin sees and manages everything; everyone else
-- sees only the brands they are a member of, as a viewer or as that brand's admin.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT,
  super INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  -- Bumped on sign-out everywhere, password change or removal: older sessions stop working.
  session_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','admin')),
  PRIMARY KEY (user_id, brand_id)
);
-- One-time secrets sent by email: sign-in codes, invitations and password resets. Only hashes.
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('code','invite','reset')),
  secret_hash TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
`

export type DB = DatabaseSync

export function openDb(file = join(DATA_DIR, 'socialmonitor.db')): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  migrate(db)
  closeAnswered(db)
  return db
}

/**
 * Comments the brand already answered on the network are closed: a reply under them written by
 * the brand's own account (its handle, or on Facebook its page name) marks them done, with the
 * time of that reply. Runs after every update and once on start for older data.
 */
export function closeAnswered(db: DatabaseSync, postId?: number) {
  db.prepare(
    `UPDATE comments AS c SET reply_status = 'done', answered_by = 'brand',
       answered_at = (
         SELECT min(r.posted_at) FROM comments r JOIN posts p ON p.id = r.post_id
           JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id
         WHERE r.post_id = c.post_id AND r.parent_ext_id = c.ext_id
           AND (lower(r.author) = lower(pr.handle) OR lower(r.author) = lower(b.name)))
     WHERE c.reply_status = 'open' AND (? IS NULL OR c.post_id = ?)
       AND EXISTS (
         SELECT 1 FROM comments r JOIN posts p ON p.id = r.post_id
           JOIN profiles pr ON pr.id = p.profile_id JOIN brands b ON b.id = pr.brand_id
         WHERE r.post_id = c.post_id AND r.parent_ext_id = c.ext_id
           AND (lower(r.author) = lower(pr.handle) OR lower(r.author) = lower(b.name)))`,
  ).run(postId ?? null, postId ?? null)
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
  // An English translation of a comment, made on request and kept.
  if (!has('comments', 'translation')) db.exec('ALTER TABLE comments ADD COLUMN translation TEXT')
  // How and when a comment was answered: on the network by the brand, or marked by a person.
  if (!has('comments', 'answered_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN answered_at TEXT')
    db.exec('ALTER TABLE comments ADD COLUMN answered_by TEXT')
    db.exec('ALTER TABLE comments ADD COLUMN done_by INTEGER')
  }
  // Who wrote a comment (picture, profile page) and a picture or sticker attached to it.
  if (!has('comments', 'author_avatar')) {
    db.exec('ALTER TABLE comments ADD COLUMN author_avatar TEXT')
    db.exec('ALTER TABLE comments ADD COLUMN author_url TEXT')
    db.exec('ALTER TABLE comments ADD COLUMN media_url TEXT')
  }
  // Which version of the AI sort read a comment: older ones are read again with today's context.
  if (!has('comments', 'sort_v')) db.exec('ALTER TABLE comments ADD COLUMN sort_v INTEGER')
  // How urgent a comment is (0–2) and how the person feels, from the AI sort.
  if (!has('comments', 'urgency')) {
    db.exec('ALTER TABLE comments ADD COLUMN urgency INTEGER')
    db.exec('ALTER TABLE comments ADD COLUMN emotion TEXT')
  }
  // When a post's comments were last read with their people's photos and attached pictures.
  // Posts read before that was collected stay "unknown" until one update reads them again.
  if (!has('posts', 'people_read_at')) db.exec('ALTER TABLE posts ADD COLUMN people_read_at TEXT')
  // Where a running update is, step by step, and whether someone asked it to stop.
  if (!has('runs', 'progress')) {
    db.exec('ALTER TABLE runs ADD COLUMN progress TEXT')
    db.exec('ALTER TABLE runs ADD COLUMN stop INTEGER NOT NULL DEFAULT 0')
  }
  // When a post's numbers were last read, for the re-check tiers.
  if (!has('posts', 'metrics_at')) db.exec('ALTER TABLE posts ADD COLUMN metrics_at TEXT')
  // Who gets the bad-comments report, in which language, and whether it goes out after updates.
  if (!has('brands', 'alert_emails')) {
    db.exec("ALTER TABLE brands ADD COLUMN alert_emails TEXT NOT NULL DEFAULT '[]'")
    db.exec('ALTER TABLE brands ADD COLUMN alert_auto INTEGER NOT NULL DEFAULT 0')
    db.exec("ALTER TABLE brands ADD COLUMN alert_lang TEXT NOT NULL DEFAULT 'en'")
    db.exec('ALTER TABLE brands ADD COLUMN alert_sent_at TEXT')
  }
  // Words the brand watches for in comments: its products, other brands, topics.
  if (!has('brands', 'trackers'))
    db.exec("ALTER TABLE brands ADD COLUMN trackers TEXT NOT NULL DEFAULT '[]'")
  // The brand's reply target in hours: open comments older than it count as overdue.
  // Whether Claude sorts this brand's comments and describes its posts after each update.
  if (!has('brands', 'ai_sort'))
    db.exec('ALTER TABLE brands ADD COLUMN ai_sort INTEGER NOT NULL DEFAULT 1')
  if (!has('brands', 'reply_target_hours'))
    db.exec('ALTER TABLE brands ADD COLUMN reply_target_hours REAL NOT NULL DEFAULT 24')
  // Each person's own view choices (filters, layouts, period, theme), kept across sign-ins.
  if (!has('users', 'prefs'))
    db.exec("ALTER TABLE users ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}'")
  // The language a person reads the dashboard in, for the emails they get.
  if (!has('users', 'lang')) db.exec("ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'")
  // Each brand's own positive and negative categories.
  if (!has('brands', 'categories'))
    db.exec("ALTER TABLE brands ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'")
}

export const now = () => new Date().toISOString()
