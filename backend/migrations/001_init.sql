CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  display_name text NOT NULL,
  team_id text,
  disabled boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL,
  availability text NOT NULL,
  eta_note text,
  updated_at bigint NOT NULL,
  simulated boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  message_id text UNIQUE NOT NULL,
  origin_pseudonym text NOT NULL,
  incident_key text NOT NULL,
  incident_type text NOT NULL,
  emergency_state text NOT NULL,
  priority integer NOT NULL,
  people_count integer,
  injury_severity text,
  mobility text,
  vulnerable_count integer,
  summary_text text,
  language text,
  lat double precision,
  lon double precision,
  accuracy_m integer,
  location_time bigint,
  event_timestamp bigint NOT NULL,
  received_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  verification_level text NOT NULL,
  source_auth text NOT NULL,
  content_sequence integer NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  cancelled boolean NOT NULL DEFAULT false,
  assigned_team_id text,
  operator_note text,
  raw_payload text NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_conflicts (
  id text PRIMARY KEY,
  incident_id text NOT NULL,
  message_id text NOT NULL,
  reason text NOT NULL,
  at_ms bigint NOT NULL,
  resolved boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS packets (
  message_id text PRIMARY KEY,
  origin_pseudonym text NOT NULL,
  payload_type text NOT NULL,
  priority integer NOT NULL,
  event_timestamp bigint NOT NULL,
  received_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  hop_count integer NOT NULL,
  signature_valid boolean NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  raw_hex text NOT NULL,
  accept_result text NOT NULL,
  reject_reason text
);

CREATE TABLE IF NOT EXISTS delivery_events (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  state text NOT NULL,
  at_ms bigint NOT NULL,
  actor text,
  detail text
);

CREATE TABLE IF NOT EXISTS emergency_groups (
  id text PRIMARY KEY,
  incident_type text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  confidence text NOT NULL,
  centroid_lat double precision,
  centroid_lon double precision,
  simulated boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  assigned_team_id text,
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id text NOT NULL,
  incident_id text NOT NULL,
  joined_at bigint NOT NULL,
  PRIMARY KEY (group_id, incident_id)
);

CREATE TABLE IF NOT EXISTS group_lineage (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  group_id text NOT NULL,
  other_group_id text,
  at_ms bigint NOT NULL,
  details text NOT NULL,
  simulated boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  severity text NOT NULL,
  kind text NOT NULL,
  source_label text NOT NULL,
  language text NOT NULL,
  lat double precision,
  lon double precision,
  radius_m integer,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  ai_generated boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  at_ms bigint NOT NULL,
  actor text,
  action text NOT NULL,
  target text,
  detail text NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id text PRIMARY KEY,
  kind text NOT NULL,
  lat double precision,
  lon double precision,
  accuracy_m integer,
  observed_at bigint NOT NULL,
  source_id text,
  simulated boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS simulator_runs (
  id text PRIMARY KEY,
  scenario text NOT NULL,
  seed integer NOT NULL,
  started_at bigint NOT NULL,
  finished_at bigint NOT NULL,
  metrics_json text NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id text PRIMARY KEY,
  incident_id text,
  sha256 text NOT NULL,
  bytes integer NOT NULL,
  mime text NOT NULL,
  stored_path text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS incidents_live_idx ON incidents (simulated, emergency_state, event_timestamp);
CREATE INDEX IF NOT EXISTS packets_received_idx ON packets (received_at);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_logs (at_ms);
