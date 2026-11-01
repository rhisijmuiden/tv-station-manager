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
  // Week schedule: categories (sport, culture…), hour clocks, recurring week slots and the editor's rundown per occurrence.
  `CREATE TABLE categories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#3B6CFF',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   ALTER TABLE blocks ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
   -- Hidden blocks hold the rundown of one week-schedule occurrence; they are not listed on the blocks page.
   ALTER TABLE blocks ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE media ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
   ALTER TABLE media ADD COLUMN last_auto_at TEXT;
   CREATE INDEX media_category ON media(category_id);

   CREATE TABLE clocks (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#3B6CFF',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE clock_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     clock_id INTEGER NOT NULL REFERENCES clocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('block','program')),
     block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     duration_ms INTEGER,
     title TEXT
   );
   CREATE INDEX clock_items_clock ON clock_items(clock_id, position);

   ALTER TABLE channels ADD COLUMN clock_id INTEGER REFERENCES clocks(id) ON DELETE SET NULL;
   ALTER TABLE channels ADD COLUMN week_enabled INTEGER NOT NULL DEFAULT 0;

   CREATE TABLE week_slots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
     start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
     duration_min INTEGER NOT NULL CHECK (duration_min BETWEEN 1 AND 1440),
     clock_mode TEXT NOT NULL DEFAULT 'channel' CHECK (clock_mode IN ('channel','clock','none')),
     clock_id INTEGER REFERENCES clocks(id) ON DELETE SET NULL,
     block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
     category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
     title TEXT,
     description TEXT,
     in_epg INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX week_slots_channel ON week_slots(channel_id, weekday, start_min);

   -- Rundown of one occurrence (slot on a date): picked automatically from the category, or put together by an editor.
   CREATE TABLE week_fills (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slot_id INTEGER NOT NULL REFERENCES week_slots(id) ON DELETE CASCADE,
     date TEXT NOT NULL,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','manual')),
     ready INTEGER NOT NULL DEFAULT 0,
     updated_by TEXT,
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     UNIQUE (slot_id, date)
   );

   -- Schedule entries generated from the week schedule (origin 'week') are replaced when it is published again.
   ALTER TABLE schedule ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
   ALTER TABLE schedule ADD COLUMN week_slot_id INTEGER REFERENCES week_slots(id) ON DELETE SET NULL;
   ALTER TABLE schedule ADD COLUMN occurrence TEXT;
   ALTER TABLE schedule ADD COLUMN skip_items INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE schedule ADD COLUMN take_items INTEGER;
   CREATE INDEX schedule_origin ON schedule(channel_id, origin, start_at);`,
  // Two studio nodes per channel: a playout node runs the schedule, a live node takes RTMP/SRT streams from events.
  `ALTER TABLE studio_nodes ADD COLUMN role TEXT NOT NULL DEFAULT 'both' CHECK (role IN ('playout','live','both'));`,
  // Stream output: CasparCG channels or remote sources streamed over RTMP(S) to stream servers / social platforms.
  `CREATE TABLE stream_destinations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     platform TEXT NOT NULL DEFAULT 'custom' CHECK (platform IN ('custom','youtube','facebook','twitch')),
     url TEXT NOT NULL,
     stream_key TEXT NOT NULL DEFAULT '',
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE stream_outputs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('channel','remote')),
     studio_id INTEGER REFERENCES studio_nodes(id) ON DELETE SET NULL,
     caspar_channel INTEGER,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE SET NULL,
     encoder TEXT NOT NULL DEFAULT 'x264' CHECK (encoder IN ('x264','nvenc')),
     video_kbps INTEGER NOT NULL DEFAULT 4500,
     audio_kbps INTEGER NOT NULL DEFAULT 160,
     resolution TEXT NOT NULL DEFAULT 'source' CHECK (resolution IN ('source','720p')),
     deinterlace INTEGER NOT NULL DEFAULT 1,
     extra_args TEXT NOT NULL DEFAULT '',
     active INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE stream_output_destinations (
     output_id INTEGER NOT NULL REFERENCES stream_outputs(id) ON DELETE CASCADE,
     destination_id INTEGER NOT NULL REFERENCES stream_destinations(id) ON DELETE CASCADE,
     PRIMARY KEY (output_id, destination_id)
   );`,
  // Slot of the parked Visual Radio module (branch parked/visual-radio). Migrations are numbered by position,
  // so this slot stays: it removes the tables on nodes that already created them and does nothing on new ones.
  `DROP TABLE IF EXISTS vr_songs;
   DROP TABLE IF EXISTS vr_clips;
   DROP TABLE IF EXISTS vr_mics;
   DROP TABLE IF EXISTS vr_stations;`,
  // RSS feeds (WordPress sites or any RSS/Atom feed) and full-screen beeldkranten (news pages) built from their items.
  // block_items gets a 'beeldkrant' type: SQLite cannot change a CHECK constraint, so the table is rebuilt.
  `CREATE TABLE rss_feeds (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'wordpress' CHECK (kind IN ('wordpress','rss')),
     url TEXT NOT NULL,
     -- WordPress categories [{ id, slug, name }]; empty = all posts.
     categories TEXT NOT NULL DEFAULT '[]',
     enabled INTEGER NOT NULL DEFAULT 1,
     refresh_min INTEGER NOT NULL DEFAULT 10,
     max_items INTEGER NOT NULL DEFAULT 20,
     last_fetch_at TEXT,
     last_ok_at TEXT,
     last_error TEXT,
     -- How the last fetch was done: 'wp-json' (REST API, featured images) or 'rss'.
     via TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE rss_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     feed_id INTEGER NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
     guid TEXT NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL DEFAULT '',
     link TEXT,
     image_url TEXT,
     author TEXT,
     categories TEXT NOT NULL DEFAULT '[]',
     published_at TEXT,
     seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     UNIQUE (feed_id, guid)
   );
   CREATE INDEX rss_items_feed ON rss_items(feed_id, published_at);
   CREATE TABLE beeldkranten (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     -- Layout and timing (JSON, see beeldkrantSchema in rsslogic.ts).
     settings TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE beeldkrant_feeds (
     beeldkrant_id INTEGER NOT NULL REFERENCES beeldkranten(id) ON DELETE CASCADE,
     feed_id INTEGER NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (beeldkrant_id, feed_id)
   );

   CREATE TABLE block_items_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('media','block','live','beeldkrant')),
     media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
     child_block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE CASCADE,
     beeldkrant_id INTEGER REFERENCES beeldkranten(id) ON DELETE CASCADE,
     duration_ms INTEGER,
     title TEXT
   );
   INSERT INTO block_items_new (id, block_id, position, type, media_id, child_block_id, live_source_id, duration_ms, title)
     SELECT id, block_id, position, type, media_id, child_block_id, live_source_id, duration_ms, title FROM block_items;
   DROP TABLE block_items;
   ALTER TABLE block_items_new RENAME TO block_items;
   CREATE INDEX block_items_block ON block_items(block_id, position);`,
];
