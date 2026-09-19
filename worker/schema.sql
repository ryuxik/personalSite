-- Selects — private client galleries. D1 schema (idempotent; the Worker also
-- applies this lazily per isolate so `wrangler dev --local` needs no setup).
-- Bytes live in R2 (`galleries/<gid>/<pid>/v<n>/<kind>`); this database is the
-- paper trail and survives deletion of the bytes (SPEC.md § Client galleries).

CREATE TABLE IF NOT EXISTS galleries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  client_name   TEXT NOT NULL DEFAULT '',
  n_marks       INTEGER NOT NULL DEFAULT 3,     -- "mark your N favorites for polish"
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | live | deleted
  access_key    TEXT NOT NULL,                  -- 16 chars base32 = 80 bits; the URL credential
  key_version   INTEGER NOT NULL DEFAULT 1,     -- bumps on rotate; media paths carry it
  expiry_at     TEXT NOT NULL,                  -- ISO datetime; cron enforces
  marks_state   TEXT NOT NULL DEFAULT 'open',   -- open | submitted
  marks_note    TEXT NOT NULL DEFAULT '',
  marks_submitted_at TEXT,
  veto_notified_at TEXT,                     -- last do-not-post email (rate limit + cron sweep cursor)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT,
  purge_after   TEXT,                           -- end of the 7-day trash grace
  warn14_sent   INTEGER NOT NULL DEFAULT 0,
  warn3_sent    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id  INTEGER NOT NULL REFERENCES galleries(id),
  stem        TEXT NOT NULL,                    -- filename stem; display order = stem sort
  position    INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,       -- bumps when the original is re-uploaded (polish loop)
  replaced_at TEXT,
  width       INTEGER,                          -- of the preview master
  height      INTEGER,
  is_hdr      INTEGER NOT NULL DEFAULT 1,
  thumbhash   TEXT NOT NULL DEFAULT '',         -- base64 PNG data-URI, painted while loading
  color       TEXT NOT NULL DEFAULT '#1a1614',  -- average colour
  marked      INTEGER NOT NULL DEFAULT 0,       -- one shared mark set per gallery
  marked_by   TEXT NOT NULL DEFAULT '',
  marked_at   TEXT,
  vetoed      INTEGER NOT NULL DEFAULT 0,      -- round 2: client consent — do NOT post on social
  vetoed_by   TEXT NOT NULL DEFAULT '',
  vetoed_at   TEXT,
  removed     INTEGER NOT NULL DEFAULT 0,    -- soft-removed: hidden everywhere, bytes purged after grace
  removed_at  TEXT,
  UNIQUE (gallery_id, stem)
);

CREATE TABLE IF NOT EXISTS assets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id     INTEGER NOT NULL REFERENCES photos(id),
  kind         TEXT NOT NULL,    -- original|instagram|rednote|preview|l900|l1400|l2048|a900|a1400|a2048
  version      INTEGER NOT NULL DEFAULT 1,
  r2_key       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  crc32        INTEGER NOT NULL, -- unsigned; computed at ingest so zips stream with zero CPU
  content_type TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  filename     TEXT NOT NULL,    -- the download / zip-entry name
  UNIQUE (photo_id, kind, version)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id   INTEGER NOT NULL REFERENCES photos(id),
  author     TEXT NOT NULL,
  by_owner   INTEGER NOT NULL DEFAULT 0,        -- 1 = Santiago's reply
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved   INTEGER NOT NULL DEFAULT 0,
  notified   INTEGER NOT NULL DEFAULT 0         -- swept into a digest email yet?
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id INTEGER,
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Site funnel analytics (SPEC.md § Site analytics). First-party, cookieless,
-- no IP, no raw user agent, no PII. Dimensions live once per session; events
-- stay narrow. NOT the `events` table above — that one is the gallery audit log.
CREATE TABLE IF NOT EXISTS site_sessions (
  sid          TEXT PRIMARY KEY,                -- random, sessionStorage; 30 min idle = new session
  vid          TEXT,                            -- random, localStorage; NULL under GPC / DNT
  started_at   TEXT NOT NULL,                   -- server clock minus the client's relative offset
  landing_path TEXT NOT NULL,
  source       TEXT NOT NULL,                   -- resolved: ?s= tag > utm_source > referrer > in-app UA > direct
  source_raw   TEXT NOT NULL DEFAULT '',        -- the tag / utm exactly as sent
  visit_n      INTEGER NOT NULL DEFAULT 1,      -- nth session for this vid
  ref_host     TEXT NOT NULL DEFAULT '',        -- host only, never the full referrer
  country      TEXT NOT NULL DEFAULT '',        -- request.cf.country
  device       TEXT NOT NULL DEFAULT '',        -- mobile | tablet | desktop
  browser      TEXT NOT NULL DEFAULT '',        -- ig-inapp | xhs-inapp | wechat | safari | chrome | firefox | other
  build        TEXT NOT NULL DEFAULT '',        -- site version the visitor saw
  human        INTEGER NOT NULL DEFAULT 0,      -- 1 after a trusted input event
  internal     INTEGER NOT NULL DEFAULT 0       -- 1 = the photographer's own browser
);

CREATE TABLE IF NOT EXISTS site_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  sid    TEXT NOT NULL,
  seq    INTEGER NOT NULL,                      -- client sequence; with sid, makes retried beacons idempotent
  t_ms   INTEGER NOT NULL,                      -- ms since session start (relative, so client clock skew is moot)
  path   TEXT NOT NULL,
  name   TEXT NOT NULL,                         -- closed vocabulary, worker/routes/track.ts
  detail TEXT NOT NULL DEFAULT '',
  v      REAL,                                  -- numeric payload: ms, percent, seconds
  UNIQUE (sid, seq)
);

CREATE INDEX IF NOT EXISTS idx_site_sessions_started ON site_sessions (started_at);
CREATE INDEX IF NOT EXISTS idx_site_events_name ON site_events (name, detail);

CREATE INDEX IF NOT EXISTS idx_photos_gallery ON photos (gallery_id, position, stem);
CREATE INDEX IF NOT EXISTS idx_assets_photo   ON assets (photo_id, kind, version);
CREATE INDEX IF NOT EXISTS idx_comments_photo ON comments (photo_id, created_at);
