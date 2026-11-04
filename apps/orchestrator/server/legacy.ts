/**
 * Migrations of features that were removed from the orchestrator. Migrations are numbered by position, so these
 * stay in the list for ever; the tables they create are simply no longer used.
 *
 * HyperDeck support was parked on 2026-11-03 (there is no HyperDeck in the facility; the device at that address is a
 * Teranex). The code lives on the branch `parked/hyperdeck`, see docs/parked/hyperdeck.md.
 */

export const HYPERDECK_MIGRATIONS = [
  `CREATE TABLE hyperdecks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     host TEXT NOT NULL UNIQUE,
     location TEXT NOT NULL DEFAULT '',
     notes TEXT NOT NULL DEFAULT '',
     online INTEGER NOT NULL DEFAULT 0,
     snapshot TEXT,
     last_seen_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE TABLE hyperdeck_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     deck_id TEXT NOT NULL REFERENCES hyperdecks(id) ON DELETE CASCADE,
     type TEXT NOT NULL,
     message TEXT NOT NULL,
     at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   );
   CREATE INDEX hyperdeck_events_deck ON hyperdeck_events(deck_id, at);
   CREATE TRIGGER diagram_hyperdeck_gone AFTER DELETE ON hyperdecks BEGIN DELETE FROM diagram_devices WHERE kind = 'device' AND ref_id = 'hyperdeck:' || OLD.id; END;`,
];
