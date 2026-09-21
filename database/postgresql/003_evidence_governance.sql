ALTER TABLE evidence ADD COLUMN IF NOT EXISTS retention_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_evidence_retention ON evidence(retention_until) WHERE deleted_at IS NULL AND retention_hold=false;
