CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('contributor', 'moderator', 'admin');
CREATE TYPE user_status AS ENUM ('pending_verification', 'active', 'suspended', 'deletion_pending', 'deleted');
CREATE TYPE content_status AS ENUM ('draft', 'pending', 'published', 'rejected', 'changes_requested', 'hidden', 'deleted');
CREATE TYPE comment_status AS ENUM ('pending', 'published', 'rejected', 'hidden', 'deleted');
CREATE TYPE media_status AS ENUM ('quarantined', 'scanning', 'processing', 'manual_review', 'ready', 'rejected', 'failed', 'deleted');
CREATE TYPE auth_token_type AS ENUM ('email_verification', 'password_reset');
CREATE TYPE report_target_type AS ENUM ('feature', 'comment');
CREATE TYPE report_status AS ENUM ('open', 'resolved', 'dismissed');
CREATE TYPE confirmation_result AS ENUM ('still_accurate', 'changed', 'closed');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role user_role NOT NULL DEFAULT 'contributor',
  status user_status NOT NULL DEFAULT 'pending_verification',
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at DESC);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type auth_token_type NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_type_idx ON auth_tokens(user_id, type, expires_at DESC);

CREATE TABLE categories (
  key text PRIMARY KEY,
  name text NOT NULL,
  icon text NOT NULL,
  detail_schema jsonb NOT NULL,
  detail_schema_version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE map_features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_key text NOT NULL REFERENCES categories(key),
  owner_id uuid NOT NULL REFERENCES users(id),
  geom geography(Point, 4326) NOT NULL,
  location_accuracy_m integer NOT NULL CHECK (location_accuracy_m BETWEEN 3 AND 100),
  current_revision_id uuid,
  status content_status NOT NULL DEFAULT 'draft',
  first_published_at timestamptz,
  freshness_expires_at timestamptz,
  needs_review_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX map_features_geom_gix ON map_features USING gist (geom);
CREATE INDEX map_features_public_idx ON map_features(status, category_key, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE feature_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  revision_no integer NOT NULL,
  payload jsonb NOT NULL,
  status content_status NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewer_id uuid REFERENCES users(id),
  rejection_reason_code text,
  moderation_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_id, revision_no)
);
CREATE INDEX feature_revisions_feature_idx ON feature_revisions(feature_id, revision_no DESC);
CREATE INDEX feature_revisions_queue_idx ON feature_revisions(status, submitted_at) WHERE status = 'pending';

ALTER TABLE map_features
  ADD CONSTRAINT map_features_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES feature_revisions(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  width integer,
  height integer,
  sha256 text,
  perceptual_hash text,
  quarantine_object_key text NOT NULL UNIQUE,
  processed_object_key text,
  public_object_key text,
  thumbnail_object_key text,
  privacy_status media_status NOT NULL DEFAULT 'quarantined',
  privacy_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_code text,
  processed_at timestamptz,
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX media_assets_owner_idx ON media_assets(owner_id, created_at DESC);
CREATE INDEX media_assets_privacy_queue_idx ON media_assets(privacy_status, created_at) WHERE privacy_status = 'manual_review';
CREATE INDEX media_assets_hash_idx ON media_assets(sha256);

CREATE TABLE revision_media (
  revision_id uuid NOT NULL REFERENCES feature_revisions(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (revision_id, media_id)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  parent_id uuid REFERENCES comments(id) ON DELETE CASCADE,
  body text NOT NULL,
  status comment_status NOT NULL DEFAULT 'pending',
  edited_at timestamptz,
  reviewed_at timestamptz,
  reviewer_id uuid REFERENCES users(id),
  rejection_reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_feature_idx ON comments(feature_id, status, created_at DESC);
CREATE INDEX comments_queue_idx ON comments(status, created_at) WHERE status = 'pending';

CREATE TABLE feature_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id uuid NOT NULL REFERENCES map_features(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  result confirmation_result NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_id, user_id)
);
CREATE INDEX feature_confirmations_feature_idx ON feature_confirmations(feature_id, created_at DESC);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id),
  target_type report_target_type NOT NULL,
  target_id uuid NOT NULL,
  reason_code text NOT NULL,
  notes text,
  status report_status NOT NULL DEFAULT 'open',
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reports_one_open_per_user_idx
  ON reports(reporter_id, target_type, target_id)
  WHERE status = 'open';
CREATE INDEX reports_queue_idx ON reports(status, created_at);

CREATE TABLE moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type report_target_type NOT NULL,
  target_id uuid NOT NULL,
  moderator_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  reason_code text,
  notes text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_target_idx ON moderation_actions(target_type, target_id, created_at DESC);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_events_queue_idx ON outbox_events(status, available_at);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_resource_idx ON audit_logs(resource_type, resource_id, created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  link text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, read_at, created_at DESC);

-- migrate:down
DROP TABLE notifications;
DROP TABLE audit_logs;
DROP TABLE outbox_events;
DROP TABLE moderation_actions;
DROP TABLE reports;
DROP TABLE feature_confirmations;
DROP TABLE comments;
DROP TABLE revision_media;
DROP TABLE media_assets;
ALTER TABLE map_features DROP CONSTRAINT map_features_current_revision_fk;
DROP TABLE feature_revisions;
DROP TABLE map_features;
DROP TABLE categories;
DROP TABLE auth_tokens;
DROP TABLE sessions;
DROP TABLE users;

DROP TYPE report_status;
DROP TYPE report_target_type;
DROP TYPE auth_token_type;
DROP TYPE media_status;
DROP TYPE comment_status;
DROP TYPE content_status;
DROP TYPE user_status;
DROP TYPE user_role;
DROP TYPE confirmation_result;

