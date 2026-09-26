-- Down migration for 0001_init.sql
-- Drops every table and custom type created by the initial migration.
-- Extensions (postgis, pgcrypto) are left installed: they may be shared by
-- other databases/roles and removing them is outside application rollback.
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS outbox_events CASCADE;
DROP TABLE IF EXISTS moderation_actions CASCADE;
DROP TABLE IF EXISTS reports CASCADE;
DROP TABLE IF EXISTS feature_confirmations CASCADE;
DROP TABLE IF EXISTS comments CASCADE;
DROP TABLE IF EXISTS revision_media CASCADE;
DROP TABLE IF EXISTS media_assets CASCADE;
DROP TABLE IF EXISTS map_features CASCADE;
DROP TABLE IF EXISTS feature_revisions CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS auth_tokens CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP TYPE IF EXISTS confirmation_result;
DROP TYPE IF EXISTS report_status;
DROP TYPE IF EXISTS report_target_type;
DROP TYPE IF EXISTS auth_token_type;
DROP TYPE IF EXISTS media_status;
DROP TYPE IF EXISTS comment_status;
DROP TYPE IF EXISTS content_status;
DROP TYPE IF EXISTS user_status;
DROP TYPE IF EXISTS user_role;
