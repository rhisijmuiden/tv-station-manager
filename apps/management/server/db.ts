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
  // Recordings of remote sources (RTMP/SRT): recorded on the management node, trimmed, then put in the library.
  `ALTER TABLE live_sources ADD COLUMN recording TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE recordings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE SET NULL,
     source_name TEXT NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','processing','ready','publishing','published','failed')),
     -- Why the recording stopped: stream_end, programme_end, manual, restart.
     stop_reason TEXT,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     -- Programme in the schedule that this recording is (live item of the remote source), if any.
     schedule_id INTEGER,
     channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
     -- Pieces recorded so far (JSON array of file names; a new piece starts when the stream reconnects).
     parts TEXT NOT NULL DEFAULT '[]',
     file TEXT,
     size INTEGER,
     duration_ms INTEGER,
     width INTEGER,
     height INTEGER,
     fps REAL,
     codec TEXT,
     trim_in_ms INTEGER NOT NULL DEFAULT 0,
     trim_out_ms INTEGER,
     category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
     media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
     media_source_id INTEGER REFERENCES media_sources(id) ON DELETE SET NULL,
     media_path TEXT,
     -- Trim points of the file in the library ("in:out"); differs from the current ones after trimming again.
     published_trim TEXT,
     published_at TEXT,
     block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
     -- Repeats to plan once the recording is in the library (JSON [{channelId, at}]).
     pending_repeats TEXT NOT NULL DEFAULT '[]',
     error TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX recordings_started ON recordings(started_at);`,
  // Switch buttons: simple named buttons for editors that take a live source on air by hand (unplanned live feeds).
  // recordings.plan holds what the editor chose when going live (record, repeat), overriding the source's settings.
  `CREATE TABLE switch_buttons (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     color TEXT NOT NULL DEFAULT '#3B6CFF',
     live_source_id INTEGER NOT NULL REFERENCES live_sources(id) ON DELETE CASCADE,
     position INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX switch_buttons_channel ON switch_buttons(channel_id, position);
   ALTER TABLE recordings ADD COLUMN plan TEXT;`,
  // Audio under the broadcast ("geluid onder"): a radio stream or a physical input on the studio node, mixed under
  // what CasparCG plays (e.g. behind the beeldkrant). Chosen per block or per item; NULL = follow the parent,
  // 'none' = no audio, '<id>' = that audio source.
  `CREATE TABLE audio_sources (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('stream','soundcard','decklink')),
     -- stream: http(s)/HLS/Icecast URL; soundcard: Windows recording device name; decklink: device number.
     address TEXT NOT NULL,
     -- Studio node that has the physical input (soundcard/decklink); NULL for streams.
     studio_id INTEGER REFERENCES studio_nodes(id) ON DELETE SET NULL,
     volume INTEGER NOT NULL DEFAULT 70 CHECK (volume BETWEEN 0 AND 150),
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   ALTER TABLE blocks ADD COLUMN audio TEXT;
   ALTER TABLE block_items ADD COLUMN audio TEXT;`,
  // Webcams and external streams (webcam sites, RTSP cameras, HLS, RTMP/SRT, MJPEG, pictures) as items in a programme.
  // block_items gets a 'webcam' type: SQLite cannot change a CHECK constraint, so the table is rebuilt again.
  `CREATE TABLE webcams (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('hls','rtsp','rtmp','srt','video','mjpeg','image','page')),
     url TEXT NOT NULL,
     -- The web page the stream was found on (e.g. a webcam.nl page), for reference.
     page_url TEXT,
     -- Caption, length, sound, relay (JSON, see webcamSettingsSchema in webcamlogic.ts).
     settings TEXT NOT NULL DEFAULT '{}',
     -- Last check: online/offline, details of the stream, thumbnail file in <dataDir>/webcams.
     status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','online','offline')),
     info TEXT NOT NULL DEFAULT '{}',
     last_check_at TEXT,
     last_error TEXT,
     thumb_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );

   CREATE TABLE block_items_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('media','block','live','beeldkrant','webcam')),
     media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
     child_block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE CASCADE,
     beeldkrant_id INTEGER REFERENCES beeldkranten(id) ON DELETE CASCADE,
     webcam_id INTEGER REFERENCES webcams(id) ON DELETE CASCADE,
     duration_ms INTEGER,
     title TEXT,
     audio TEXT
   );
   INSERT INTO block_items_new (id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, duration_ms, title, audio)
     SELECT id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, duration_ms, title, audio FROM block_items;
   DROP TABLE block_items;
   ALTER TABLE block_items_new RENAME TO block_items;
   CREATE INDEX block_items_block ON block_items(block_id, position);`,
  // "Newest clips" items (e.g. a news block): the item holds a rule (category or folder, how many), the clips follow by themselves.
  `CREATE TABLE block_items_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('media','block','live','beeldkrant','webcam','auto')),
     media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
     child_block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE CASCADE,
     beeldkrant_id INTEGER REFERENCES beeldkranten(id) ON DELETE CASCADE,
     webcam_id INTEGER REFERENCES webcams(id) ON DELETE CASCADE,
     auto_rule TEXT,
     duration_ms INTEGER,
     title TEXT,
     audio TEXT
   );
   INSERT INTO block_items_new (id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, webcam_id, duration_ms, title, audio)
     SELECT id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, webcam_id, duration_ms, title, audio FROM block_items;
   DROP TABLE block_items;
   ALTER TABLE block_items_new RENAME TO block_items;
   CREATE INDEX block_items_block ON block_items(block_id, position);`,
  // Dynamic items that pick in turn or at random: the picks of a broadcast are remembered until it has aired.
  `CREATE TABLE auto_picks (
     key TEXT NOT NULL,
     path TEXT NOT NULL,
     at TEXT NOT NULL,
     rule TEXT NOT NULL,
     media_ids TEXT NOT NULL,
     PRIMARY KEY (key, path)
   );
   CREATE INDEX auto_picks_at ON auto_picks(at);
   ALTER TABLE media ADD COLUMN last_pick_at TEXT;`,
  // "Coming up" slide: a full-screen page with the programmes of the coming hour, made from the schedule.
  `CREATE TABLE block_items_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('media','block','live','beeldkrant','webcam','auto','lineup')),
     media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
     child_block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE CASCADE,
     beeldkrant_id INTEGER REFERENCES beeldkranten(id) ON DELETE CASCADE,
     webcam_id INTEGER REFERENCES webcams(id) ON DELETE CASCADE,
     auto_rule TEXT,
     duration_ms INTEGER,
     title TEXT,
     audio TEXT
   );
   INSERT INTO block_items_new (id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, webcam_id, auto_rule, duration_ms, title, audio)
     SELECT id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, webcam_id, auto_rule, duration_ms, title, audio FROM block_items;
   DROP TABLE block_items;
   ALTER TABLE block_items_new RENAME TO block_items;
   CREATE INDEX block_items_block ON block_items(block_id, position);`,
  // "Rest of the hour" of a block: what plays after its material until the next whole hour (beeldkrant:<id> / webcam:<id>).
  `ALTER TABLE blocks ADD COLUMN fill TEXT;`,
  // Hour blocks begin with the channel's fixed hour start (graphics.hourStart); existing blocks keep playing as before.
  `ALTER TABLE blocks ADD COLUMN hour_start INTEGER NOT NULL DEFAULT 0;`,
  // Info pages: fixed full-screen pages (title, text, picture) made by the editors, block item type 'info'.
  // block_items gets the 'info' type and an info_page_id column: the CHECK constraint needs a rebuild again.
  `CREATE TABLE info_pages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     -- Content, layout and default length (JSON, see infoPageSchema in infopagelogic.ts).
     settings TEXT NOT NULL DEFAULT '{}',
     image TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE block_items_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     block_id INTEGER NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('media','block','live','beeldkrant','webcam','auto','lineup','info')),
     media_id INTEGER REFERENCES media(id) ON DELETE CASCADE,
     child_block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
     live_source_id INTEGER REFERENCES live_sources(id) ON DELETE CASCADE,
     beeldkrant_id INTEGER REFERENCES beeldkranten(id) ON DELETE CASCADE,
     webcam_id INTEGER REFERENCES webcams(id) ON DELETE CASCADE,
     info_page_id INTEGER REFERENCES info_pages(id) ON DELETE CASCADE,
     auto_rule TEXT,
     duration_ms INTEGER,
     title TEXT,
     audio TEXT
   );
   INSERT INTO block_items_new (id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, webcam_id, auto_rule, duration_ms, title, audio)
     SELECT id, block_id, position, type, media_id, child_block_id, live_source_id, beeldkrant_id, webcam_id, auto_rule, duration_ms, title, audio FROM block_items;
   DROP TABLE block_items;
   ALTER TABLE block_items_new RENAME TO block_items;
   CREATE INDEX block_items_block ON block_items(block_id, position);`,
  // Regional information (docs/regional-info.md): feeds can be a regional source (traffic / events / council / p2000)
  // with their settings as JSON. Items get a fixed order (rank), an editor's approval (hold = 'pending'/'rejected'),
  // a delay (show_from) and an editors-only note (the original P2000 text).
  `ALTER TABLE rss_feeds ADD COLUMN source TEXT;
   ALTER TABLE rss_feeds ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE rss_items ADD COLUMN rank INTEGER;
   ALTER TABLE rss_items ADD COLUMN hold TEXT;
   ALTER TABLE rss_items ADD COLUMN show_from TEXT;
   ALTER TABLE rss_items ADD COLUMN note TEXT;`,
  // ATEM ports (docs/atem-ports.md): the last input list a switcher reported, so the channel and switch pages can
  // still say "SDI in 8" while the ATEM is offline.
  `ALTER TABLE atem_devices ADD COLUMN inputs TEXT;`,
];
