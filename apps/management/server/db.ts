/** Management node schema (scope "management"). Times are ISO-8601 UTC strings, durations in milliseconds. */
export const MANAGEMENT_MIGRATIONS = [
  `CREATE TABLE media_sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('smb','local')),
     config TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     scan_status TEXT NOT NULL DEFAULT 'idle',
     last_scan_at TEXT,
     last_error TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE media (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     source_id INTEGER NOT NULL REFERENCES media_sources(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     name TEXT NOT NULL,
     folder TEXT NOT NULL DEFAULT '',
     size INTEGER,
     mtime TEXT,
     duration_ms INTEGER,
     fps REAL,
     width INTEGER,
     height INTEGER,
     codec TEXT,
     category TEXT NOT NULL DEFAULT 'program' CHECK (category IN ('program','commercial','jingle','bumper','filler')),
     title TEXT,
     probe_status TEXT NOT NULL DEFAULT 'pending' CHECK (probe_status IN ('pending','ok','failed','manual')),
     probe_error TEXT,
     missing INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     UNIQUE (source_id, path)
   );
   CREATE INDEX media_folder ON media(source_id, folder);

   CREATE TABLE atem_devices (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     host TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE studio_nodes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     host TEXT NOT NULL,
     port INTEGER NOT NULL DEFAULT 5250,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );

   CREATE TABLE channels (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#3B6CFF',
     enabled INTEGER NOT NULL DEFAULT 1,
     automation INTEGER NOT NULL DEFAULT 0,
     atem_id INTEGER REFERENCES atem_devices(id) ON DELETE SET NULL,
     atem_me INTEGER NOT NULL DEFAULT 0,
     transition TEXT NOT NULL DEFAULT 'cut' CHECK (transition IN ('cut','mix')),
     studio_id INTEGER REFERENCES studio_nodes(id) ON DELETE SET NULL,
     caspar_channel INTEGER NOT NULL DEFAULT 1,
     playout_input INTEGER,
     fallback_input INTEGER,
     filler_media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
     graphics TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );

   -- Live sources: an ATEM input (camera, studio) or an RTMP stream played by a studio node into an ATEM input.
   CREATE TABLE live_sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('atem','rtmp')),
     atem_input INTEGER NOT NULL,
     studio_id INTEGER REFERENCES studio_nodes(id) ON DELETE SET NULL,
     caspar_channel INTEGER,
     url TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );

   CREATE TABLE blocks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'program' CHECK (kind IN ('program','commercial')),
     color TEXT NOT NULL DEFAULT '#3B6CFF',
     description TEXT NOT NULL DEFAULT '',
     genre TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE block_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('media','block','live')),
     media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
     child_block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE CASCADE,
     duration_ms INTEGER,
     title TEXT
   );
   CREATE INDEX block_items_block ON block_items(block_id, position);

   CREATE TABLE schedule (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     start_at TEXT NOT NULL,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     title TEXT,
     description TEXT,
     in_epg INTEGER NOT NULL DEFAULT 1,
     created_by TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX schedule_channel_start ON schedule(channel_id, start_at);

   -- As-run log: what actually went on air.
   CREATE TABLE asrun (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     kind TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT,
     ok INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX asrun_channel_at ON asrun(channel_id, at);`,
  // Step 4: subtitle file (.srt/.vtt) next to the clip, found by the media scan.
  `ALTER TABLE media ADD COLUMN subtitle_path TEXT;`,
  // Remote sources: own stream key per source, checked by the studio node's ingest server through this node.
  `ALTER TABLE studio_nodes ADD COLUMN public_host TEXT;
   ALTER TABLE studio_nodes ADD COLUMN ingest_api_port INTEGER NOT NULL DEFAULT 9997;
   ALTER TABLE live_sources ADD COLUMN stream_key TEXT;
   CREATE UNIQUE INDEX live_sources_stream_key ON live_sources(stream_key);`,
];
