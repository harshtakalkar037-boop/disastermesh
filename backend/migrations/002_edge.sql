CREATE TABLE IF NOT EXISTS witness_reports (
  id text PRIMARY KEY,
  message_id text UNIQUE NOT NULL,
  origin_pseudonym text NOT NULL,
  incident_type text NOT NULL,
  claimed_state text NOT NULL,
  people_count integer,
  language text,
  waterline_band text NOT NULL,
  tilt_deg double precision,
  confidence double precision NOT NULL,
  evidence_hash text,
  inference text NOT NULL,
  self_conflict boolean NOT NULL,
  life_threat boolean NOT NULL,
  summary_text text NOT NULL,
  model text NOT NULL,
  gate_decision text,
  gate_reason text,
  fragments_saved integer NOT NULL DEFAULT 0,
  lat double precision,
  lon double precision,
  accuracy_m integer,
  event_timestamp bigint NOT NULL,
  received_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS heard_digests (
  id text PRIMARY KEY,
  message_id text UNIQUE NOT NULL,
  origin_pseudonym text NOT NULL,
  window_start_ms bigint NOT NULL,
  battery_bucket text NOT NULL,
  pseudonyms_json text NOT NULL,
  held_message_id text,
  received_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_requests (
  id text PRIMARY KEY,
  witness_id text NOT NULL,
  actor text NOT NULL,
  expected_hash text,
  status text NOT NULL,
  explicit boolean NOT NULL,
  requested_at bigint NOT NULL,
  verified_at bigint,
  verify_reason text
);

CREATE TABLE IF NOT EXISTS gate_events (
  id text PRIMARY KEY,
  message_id text,
  origin_pseudonym text,
  decision text NOT NULL,
  reason text NOT NULL,
  new_fields text NOT NULL,
  fragments_saved integer NOT NULL,
  at_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS witness_conflicts (
  id text PRIMARY KEY,
  origin_pseudonym text NOT NULL,
  left_message_id text NOT NULL,
  right_message_id text NOT NULL,
  field text NOT NULL,
  left_value text,
  right_value text,
  at_ms bigint NOT NULL
);
