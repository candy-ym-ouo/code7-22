-- Down migration for 0002_media_public_thumb.sql
ALTER TABLE media_assets
  DROP COLUMN IF EXISTS public_thumbnail_object_key;

ALTER TABLE outbox_events
  DROP COLUMN IF EXISTS updated_at;
