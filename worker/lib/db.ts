/**
 * D1 access for Selects. The schema (worker/schema.sql) is applied lazily
 * once per isolate, so `wrangler dev --local` needs no migration step and a
 * fresh production database heals itself on first touch.
 */

export interface GalleryRow {
  id: number;
  slug: string;
  title: string;
  client_name: string;
  n_marks: number;
  status: 'draft' | 'live' | 'deleted';
  access_key: string;
  key_version: number;
  expiry_at: string;
  marks_state: 'open' | 'submitted';
  marks_note: string;
  veto_notified_at: string | null;
  marks_submitted_at: string | null;
  created_at: string;
  deleted_at: string | null;
  purge_after: string | null;
  warn14_sent: number;
  warn3_sent: number;
}

export interface PhotoRow {
  id: number;
  gallery_id: number;
  stem: string;
  position: number;
  version: number;
  replaced_at: string | null;
  width: number | null;
  height: number | null;
  is_hdr: number;
  thumbhash: string;
  color: string;
  marked: number;
  marked_by: string;
  marked_at: string | null;
  vetoed: number;
  vetoed_by: string;
  vetoed_at: string | null;
  removed: number;
  removed_at: string | null;
}

export interface AssetRow {
  id: number;
  photo_id: number;
  kind: string;
  version: number;
  r2_key: string;
  bytes: number;
  crc32: number;
  content_type: string;
  width: number | null;
  height: number | null;
  filename: string;
}

// Generated from worker/schema.sql — keep the .sql file the source of truth
// and re-inline here when it changes (both are reviewed together).
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS galleries (\n  id            INTEGER PRIMARY KEY AUTOINCREMENT,\n  slug          TEXT NOT NULL UNIQUE,\n  title         TEXT NOT NULL,\n  client_name   TEXT NOT NULL DEFAULT '',\n  n_marks       INTEGER NOT NULL DEFAULT 3,    \n  status        TEXT NOT NULL DEFAULT 'draft', \n  access_key    TEXT NOT NULL,                 \n  key_version   INTEGER NOT NULL DEFAULT 1,    \n  expiry_at     TEXT NOT NULL,                 \n  marks_state   TEXT NOT NULL DEFAULT 'open',  \n  marks_note    TEXT NOT NULL DEFAULT '',\n  marks_submitted_at TEXT,\n veto_notified_at TEXT,\n  created_at    TEXT NOT NULL DEFAULT (datetime('now')),\n  deleted_at    TEXT,\n  purge_after   TEXT,                          \n  warn14_sent   INTEGER NOT NULL DEFAULT 0,\n  warn3_sent    INTEGER NOT NULL DEFAULT 0\n)",
  "CREATE TABLE IF NOT EXISTS photos (\n  id          INTEGER PRIMARY KEY AUTOINCREMENT,\n  gallery_id  INTEGER NOT NULL REFERENCES galleries(id),\n  stem        TEXT NOT NULL,                   \n  position    INTEGER NOT NULL DEFAULT 0,\n  version     INTEGER NOT NULL DEFAULT 1,      \n  replaced_at TEXT,\n  width       INTEGER,                         \n  height      INTEGER,\n  is_hdr      INTEGER NOT NULL DEFAULT 1,\n  thumbhash   TEXT NOT NULL DEFAULT '',        \n  color       TEXT NOT NULL DEFAULT '#1a1614', \n  marked      INTEGER NOT NULL DEFAULT 0,      \n  marked_by   TEXT NOT NULL DEFAULT '',\n  marked_at   TEXT,\n  vetoed      INTEGER NOT NULL DEFAULT 0,\n  vetoed_by   TEXT NOT NULL DEFAULT '',\n  vetoed_at   TEXT,\n  removed     INTEGER NOT NULL DEFAULT 0,   \n  removed_at  TEXT,\n  UNIQUE (gallery_id, stem)\n)",
  "CREATE TABLE IF NOT EXISTS assets (\n  id           INTEGER PRIMARY KEY AUTOINCREMENT,\n  photo_id     INTEGER NOT NULL REFERENCES photos(id),\n  kind         TEXT NOT NULL,   \n  version      INTEGER NOT NULL DEFAULT 1,\n  r2_key       TEXT NOT NULL,\n  bytes        INTEGER NOT NULL,\n  crc32        INTEGER NOT NULL,\n  content_type TEXT NOT NULL,\n  width        INTEGER,\n  height       INTEGER,\n  filename     TEXT NOT NULL,   \n  UNIQUE (photo_id, kind, version)\n)",
  "CREATE TABLE IF NOT EXISTS comments (\n  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n  photo_id   INTEGER NOT NULL REFERENCES photos(id),\n  author     TEXT NOT NULL,\n  by_owner   INTEGER NOT NULL DEFAULT 0,       \n  body       TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  resolved   INTEGER NOT NULL DEFAULT 0,\n  notified   INTEGER NOT NULL DEFAULT 0        \n)",
  "CREATE TABLE IF NOT EXISTS events (\n  id         INTEGER PRIMARY KEY AUTOINCREMENT,\n  gallery_id INTEGER,\n  type       TEXT NOT NULL,\n  detail     TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT (datetime('now'))\n)",
  "CREATE INDEX IF NOT EXISTS idx_photos_gallery ON photos (gallery_id, position, stem)",
  "CREATE INDEX IF NOT EXISTS idx_assets_photo   ON assets (photo_id, kind, version)",
  "CREATE INDEX IF NOT EXISTS idx_comments_photo ON comments (photo_id, created_at)",
] as const;

let schemaApplied = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaApplied) return;
  for (const sql of SCHEMA_STATEMENTS) await db.prepare(sql).run();
  schemaApplied = true;
}

export async function logEvent(
  db: D1Database,
  galleryId: number | null,
  type: string,
  detail = ''
): Promise<void> {
  await db
    .prepare('INSERT INTO events (gallery_id, type, detail) VALUES (?, ?, ?)')
    .bind(galleryId, type, detail)
    .run();
}

export async function galleryBySlug(db: D1Database, slug: string): Promise<GalleryRow | null> {
  return db.prepare('SELECT * FROM galleries WHERE slug = ?').bind(slug).first<GalleryRow>();
}

export async function galleryById(db: D1Database, id: number): Promise<GalleryRow | null> {
  return db.prepare('SELECT * FROM galleries WHERE id = ?').bind(id).first<GalleryRow>();
}

export async function galleryPhotos(db: D1Database, galleryId: number): Promise<PhotoRow[]> {
  const r = await db
    .prepare('SELECT * FROM photos WHERE gallery_id = ? AND removed = 0 ORDER BY stem')
    .bind(galleryId)
    .all<PhotoRow>();
  return r.results;
}

/** Current-version assets for every photo in a gallery, keyed `photoId/kind`. */
export async function currentAssets(db: D1Database, galleryId: number): Promise<Map<string, AssetRow>> {
  const r = await db
    .prepare(
      `SELECT a.* FROM assets a
         JOIN photos p ON p.id = a.photo_id
        WHERE p.gallery_id = ? AND p.removed = 0 AND a.version = p.version`
    )
    .bind(galleryId)
    .all<AssetRow>();
  const map = new Map<string, AssetRow>();
  for (const row of r.results) map.set(`${row.photo_id}/${row.kind}`, row);
  return map;
}
