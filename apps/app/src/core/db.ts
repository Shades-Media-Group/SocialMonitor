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

-- The latest AI summary of each brand's week (from_day to to_day): what people said, what
-- changed against the week before, and what to answer first. Paragraphs split by newlines.
CREATE TABLE IF NOT EXISTS week_summaries (
  brand_id INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  from_day TEXT NOT NULL,
  to_day TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Answers the team keeps for questions that come up again. The text may hold placeholders such
-- as {name}, filled per comment; category is one of the brand's kinds (its key), or null.
CREATE TABLE IF NOT EXISTS saved_replies (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  category TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_replies_brand ON saved_replies(brand_id);
-- A brand's campaigns: a name, an optional date range (YYYY-MM-DD, inclusive) and hints that
-- tie posts to it: hashtags (JSON, lower case, no #), keywords (JSON) and a short description.
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  starts_on TEXT,
  ends_on TEXT,
  hashtags TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]',
  about TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (brand_id, name)
);
-- Which posts belong to which campaigns, and who said so: the hints ('rule'), Claude ('ai') or a
-- person ('you'). member 0 keeps a person's "not in this campaign", so nothing adds it back.
CREATE TABLE IF NOT EXISTS post_campaigns (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  set_by TEXT NOT NULL CHECK (set_by IN ('rule','ai','you')),
  member INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (post_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS post_campaigns_campaign ON post_campaigns(campaign_id, member);

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

-- The latest post ideas the AI suggested for a brand, made on request: a JSON list and when.
CREATE TABLE IF NOT EXISTS post_ideas (
  brand_id INTEGER PRIMARY KEY REFERENCES brands(id) ON DELETE CASCADE,
  ideas TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- The audit log (core/audit.ts): who did what, when, from where. Only ever added to. No foreign
-- keys, so removing a person or a brand never touches the history. Never a secret or comment text.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor INTEGER,
  event TEXT NOT NULL,
  target TEXT,
  brand_id INTEGER,
  ip TEXT,
  ua TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor, event);
CREATE INDEX IF NOT EXISTS audit_brand ON audit(brand_id);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END;
-- Rows leave only after a year (366 days), through purgeAudit.
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
WHEN old.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-366 days')
BEGIN SELECT RAISE(ABORT, 'Audit rows are kept for a year.'); END;
-- Signed-in browsers. id is the SHA-256 of the random id in the cookie, never the id itself.
-- version is users.session_version when it began; rotate asks for a new id on the next request
-- (after a change of role); confirmed_at is when the password was last re-entered in it.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  keep INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ua TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  country TEXT,
  rotate INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- Single-use recovery codes for the second step of signing in, as SHA-256 hashes.
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);
-- Passkeys (WebAuthn credentials). id is the credential id (base64url); rp_id the host it was
-- made on (localhost or the tunnel's), since a passkey works only there.
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  rp_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
-- Each AI call (core/usage.ts): which brand and task, the tokens and the API-equivalent price in
-- USD. Only ever added to; no foreign key, so a removed brand's history stays for the Admin tab.
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  brand_id INTEGER,
  task TEXT NOT NULL,
  network TEXT,
  engine TEXT NOT NULL CHECK (engine IN ('claude','api')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  items INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS ai_usage_brand ON ai_usage(brand_id, at);
CREATE TRIGGER IF NOT EXISTS ai_usage_no_update BEFORE UPDATE ON ai_usage
BEGIN SELECT RAISE(ABORT, 'AI usage is append-only.'); END;
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
  // A rival a brand watches: read by the same updates, shown only on that brand's Share of voice.
  if (!has('brands', 'competitor_of'))
    db.exec(
      'ALTER TABLE brands ADD COLUMN competitor_of INTEGER REFERENCES brands(id) ON DELETE CASCADE',
    )
  // An authenticator app: its secret (base32) and the last step used, so each code works once.
  if (!has('users', 'totp_secret')) {
    db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT')
    db.exec('ALTER TABLE users ADD COLUMN totp_step INTEGER')
  }
  // Each brand's own positive and negative categories.
  if (!has('brands', 'categories'))
    db.exec("ALTER TABLE brands ADD COLUMN categories TEXT NOT NULL DEFAULT '[]'")
  // Instant alerts to the report's addresses: which triggers are on, and since when comments
  // count (set when a trigger is switched on, so old comments never flood the first alert).
  if (!has('brands', 'instant_urgent')) {
    db.exec('ALTER TABLE brands ADD COLUMN instant_urgent INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE brands ADD COLUMN instant_bad INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE brands ADD COLUMN instant_watched INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE brands ADD COLUMN instant_since TEXT')
  }
  // When a comment went out in an instant alert: each comment is sent once.
  if (!has('comments', 'alerted_at')) db.exec('ALTER TABLE comments ADD COLUMN alerted_at TEXT')
  // The summary email: off, weekly or monthly, and when the last one went out.
  if (!has('brands', 'digest')) {
    db.exec("ALTER TABLE brands ADD COLUMN digest TEXT NOT NULL DEFAULT 'off'")
    db.exec('ALTER TABLE brands ADD COLUMN digest_sent_at TEXT')
  }
  // How many followers a commenter had when read, where the network shows it (TikTok). Null: unknown.
  if (!has('comments', 'author_followers'))
    db.exec('ALTER TABLE comments ADD COLUMN author_followers INTEGER')
  // The brand's own logo (a /media/ path) and accent colour on its PDF reports. Empty: none.
  if (!has('brands', 'report_logo')) {
    db.exec('ALTER TABLE brands ADD COLUMN report_logo TEXT')
    db.exec('ALTER TABLE brands ADD COLUMN report_color TEXT')
  }
  // Whether posts join the brand's campaigns by themselves (hints, then Claude when the AI is on).
  if (!has('brands', 'campaign_auto'))
    db.exec('ALTER TABLE brands ADD COLUMN campaign_auto INTEGER NOT NULL DEFAULT 1')
  // When Claude last looked for a post's campaign, so it is asked again only after campaigns change.
  if (!has('posts', 'campaign_ai_at')) db.exec('ALTER TABLE posts ADD COLUMN campaign_ai_at TEXT')
}

export const now = () => new Date().toISOString()
