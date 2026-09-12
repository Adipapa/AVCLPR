-- AVCLPR Government Production Schema
-- PostgreSQL 16+
-- This is the central database target. Edge nodes may use SQLite for offline buffering.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  road VARCHAR(160),
  direction VARCHAR(32),
  jurisdiction VARCHAR(120),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active','maintenance','inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cameras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  camera_code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  host VARCHAR(255) NOT NULL,
  rtsp_port INTEGER NOT NULL DEFAULT 554 CHECK (rtsp_port BETWEEN 1 AND 65535),
  channel INTEGER NOT NULL DEFAULT 1,
  main_stream TEXT,
  ai_stream TEXT,
  preview_stream TEXT,
  credential_ref VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'offline',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(128) NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username CITEXT NOT NULL UNIQUE,
  display_name VARCHAR(160) NOT NULL,
  password_hash TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT true,
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_site_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE IF NOT EXISTS vehicle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  camera_id UUID NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  event_timestamp TIMESTAMPTZ NOT NULL,
  tracking_id BIGINT,
  vehicle_type VARCHAR(64) NOT NULL,
  direction VARCHAR(16) CHECK (direction IN ('IN','OUT','UNKNOWN')),
  lane VARCHAR(32),
  detection_confidence NUMERIC(6,5),
  plate_number VARCHAR(64),
  normalized_plate VARCHAR(64),
  plate_confidence NUMERIC(6,5),
  color_name VARCHAR(64),
  speed_kmh NUMERIC(8,2),
  snapshot_path TEXT,
  plate_image_path TEXT,
  vehicle_image_path TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  watchlist_status VARCHAR(32) DEFAULT 'none',
  watchlist_category VARCHAR(120),
  processing_time_ms INTEGER,
  model_version VARCHAR(128),
  ai_node_id VARCHAR(128),
  evidence_hash VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_timestamp ON vehicle_events(event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_events_site ON vehicle_events(site_id, event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_events_camera ON vehicle_events(camera_id, event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_vehicle_events_plate ON vehicle_events(normalized_plate);

CREATE TABLE IF NOT EXISTS watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number VARCHAR(64) NOT NULL,
  normalized_plate VARCHAR(64) NOT NULL UNIQUE,
  category VARCHAR(120) NOT NULL,
  description TEXT,
  vehicle_type VARCHAR(64),
  owner_name VARCHAR(160),
  notes TEXT,
  alert_enabled BOOLEAN NOT NULL DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES vehicle_events(id) ON DELETE SET NULL,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  camera_id UUID REFERENCES cameras(id) ON DELETE SET NULL,
  type VARCHAR(80) NOT NULL,
  severity VARCHAR(32) NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  title VARCHAR(200) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active','acknowledged','dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_by UUID REFERENCES users(id),
  acknowledged_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES vehicle_events(id) ON DELETE RESTRICT,
  evidence_type VARCHAR(32) NOT NULL,
  object_path TEXT NOT NULL,
  sha256_hash VARCHAR(64) NOT NULL,
  size_bytes BIGINT,
  captured_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(128) NOT NULL,
  resource_type VARCHAR(80),
  resource_id VARCHAR(128),
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);

INSERT INTO roles (code, name, description) VALUES
('SUPER_ADMIN','Super Administrator','Full platform administration'),
('NATIONAL_ADMIN','National Administrator','National operations and administration'),
('POLICE','Police','Authorized police monitoring and investigations'),
('TRANSPORT','Transport','Traffic and transport operations'),
('PURA','PURA','Authorized regulatory access'),
('GICTA','GICTA','Technology and infrastructure administration'),
('INTELLIGENCE','Intelligence','Authorized intelligence access'),
('ANALYST','Analyst','Analytics and reporting'),
('OPERATOR','Operator','Operational monitoring'),
('VIEW_ONLY','View Only','Read-only access')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, description) VALUES
('dashboard.read','View dashboards'),
('sites.read','View sites'),
('sites.write','Create and modify sites'),
('cameras.read','View cameras'),
('cameras.write','Configure cameras'),
('events.read','View vehicle events'),
('events.export','Export vehicle events'),
('evidence.read','View evidence'),
('evidence.export','Export evidence'),
('watchlists.read','View watchlists'),
('watchlists.write','Manage watchlists'),
('alerts.read','View alerts'),
('alerts.manage','Acknowledge and manage alerts'),
('reports.read','View reports'),
('reports.export','Export reports'),
('users.read','View users'),
('users.write','Manage users'),
('audit.read','View audit logs'),
('system.manage','Manage system configuration')
ON CONFLICT (code) DO NOTHING;
