-- Only before any protected delivery. Run against an isolated SQLite copy
-- made while Board is stopped, using sqlite3 -bail.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
CREATE TEMP TABLE rollback_guard (ok INTEGER CHECK (ok = 1));
INSERT INTO rollback_guard
SELECT CASE WHEN
  (SELECT user_version FROM pragma_user_version) = 8
  AND NOT EXISTS (SELECT 1 FROM workdesk_dialog_messages)
  AND NOT EXISTS (SELECT 1 FROM workdesk_dialog_receipts)
  AND NOT EXISTS (SELECT 1 FROM workdesk_dialog_wakes)
  AND NOT EXISTS (SELECT 1 FROM workdesk_dialog_bindings WHERE acknowledged <> 0)
  THEN 1 ELSE 0 END;
DROP TABLE workdesk_dialog_wakes;
DROP TABLE workdesk_dialog_messages;
DROP TABLE workdesk_dialog_receipts;
ALTER TABLE workdesk_dialog_bindings DROP COLUMN acknowledged;
PRAGMA user_version = 6;
COMMIT;
PRAGMA quick_check;
PRAGMA foreign_key_check;
