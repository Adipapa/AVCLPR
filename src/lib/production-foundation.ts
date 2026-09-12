import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './server-db.js';

export type RoleCode =
  | 'SUPER_ADMIN'
  | 'NATIONAL_ADMIN'
  | 'POLICE'
  | 'TRANSPORT'
  | 'PURA'
  | 'GICTA'
  | 'INTELLIGENCE'
  | 'ANALYST'
  | 'OPERATOR'
  | 'VIEW_ONLY';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: RoleCode;
  active: boolean;
}

const JWT_SECRET = process.env.AVCLPR_AUTH_SECRET || '';
const BOOTSTRAP_SECRET = process.env.AVCLPR_BOOTSTRAP_SECRET || '';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.warn('[SECURITY] AVCLPR_AUTH_SECRET must be configured with at least 32 characters.');
}

/* ---------------------------------------------------------
   CONTROL-PLANE TABLES
   These tables are suitable for an edge/pilot SQLite node.
   The canonical central production schema is PostgreSQL.
--------------------------------------------------------- */

db.exec(`
  CREATE TABLE IF NOT EXISTS avclpr_sites (
    id TEXT PRIMARY KEY,
    site_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    road TEXT,
    direction TEXT,
    jurisdiction TEXT,
    latitude REAL,
    longitude REAL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS avclpr_cameras (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    camera_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    rtsp_port INTEGER NOT NULL DEFAULT 554,
    channel INTEGER NOT NULL DEFAULT 1,
    credential_ref TEXT,
    status TEXT NOT NULL DEFAULT 'offline',
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(site_id) REFERENCES avclpr_sites(id)
  );

  CREATE INDEX IF NOT EXISTS idx_avclpr_cameras_site ON avclpr_cameras(site_id);

  CREATE TABLE IF NOT EXISTS avclpr_roles (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS avclpr_permissions (
    code TEXT PRIMARY KEY,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS avclpr_role_permissions (
    role_code TEXT NOT NULL,
    permission_code TEXT NOT NULL,
    PRIMARY KEY(role_code, permission_code)
  );

  CREATE TABLE IF NOT EXISTS avclpr_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role_code TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS avclpr_user_site_access (
    user_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    PRIMARY KEY(user_id, site_id)
  );

  CREATE TABLE IF NOT EXISTS avclpr_audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    site_id TEXT,
    ip_address TEXT,
    user_agent TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_avclpr_audit_created ON avclpr_audit_logs(created_at);
`);

const roles: Array<[RoleCode, string]> = [
  ['SUPER_ADMIN', 'Super Administrator'],
  ['NATIONAL_ADMIN', 'National Administrator'],
  ['POLICE', 'Police'],
  ['TRANSPORT', 'Transport'],
  ['PURA', 'PURA'],
  ['GICTA', 'GICTA'],
  ['INTELLIGENCE', 'Intelligence'],
  ['ANALYST', 'Analyst'],
  ['OPERATOR', 'Operator'],
  ['VIEW_ONLY', 'View Only'],
];

for (const [code, name] of roles) {
  db.prepare(`INSERT OR IGNORE INTO avclpr_roles(code,name) VALUES(?,?)`).run(code, name);
}

const permissions = [
  'dashboard.read','sites.read','sites.write','cameras.read','cameras.write',
  'events.read','events.export','evidence.read','evidence.export',
  'watchlists.read','watchlists.write','alerts.read','alerts.manage',
  'reports.read','reports.export','users.read','users.write','audit.read','system.manage',
];

for (const permission of permissions) {
  db.prepare(`INSERT OR IGNORE INTO avclpr_permissions(code,description) VALUES(?,?)`).run(permission, permission);
}

const fullAccessRoles: RoleCode[] = ['SUPER_ADMIN'];
for (const role of fullAccessRoles) {
  for (const permission of permissions) {
    db.prepare(`INSERT OR IGNORE INTO avclpr_role_permissions(role_code,permission_code) VALUES(?,?)`).run(role, permission);
  }
}

export function bootstrapAdmin(input: {
  bootstrapSecret: string;
  username: string;
  displayName: string;
  password: string;
}): AuthUser {
  if (!BOOTSTRAP_SECRET || input.bootstrapSecret !== BOOTSTRAP_SECRET) {
    throw new Error('Invalid bootstrap secret.');
  }

  if (input.password.length < 12) {
    throw new Error('Administrator password must be at least 12 characters.');
  }

  const existing = db.prepare(`SELECT id FROM avclpr_users WHERE username = ?`).get(input.username);
  if (existing) throw new Error('User already exists.');

  const now = new Date().toISOString();
  const id = randomUUID();
  const passwordHash = bcrypt.hashSync(input.password, 12);

  db.prepare(`
    INSERT INTO avclpr_users(id,username,display_name,password_hash,role_code,active,created_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?)
  `).run(id, input.username, input.displayName, passwordHash, 'SUPER_ADMIN', now, now);

  return { id, username: input.username, displayName: input.displayName, role: 'SUPER_ADMIN', active: true };
}

function getUser(username: string): (AuthUser & { passwordHash: string; failedLoginCount: number; lockedUntil?: string }) | null {
  const row = db.prepare(`SELECT * FROM avclpr_users WHERE username = ? LIMIT 1`).get(username) as any;
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role_code,
    active: Boolean(row.active),
    passwordHash: row.password_hash,
    failedLoginCount: Number(row.failed_login_count || 0),
    lockedUntil: row.locked_until || undefined,
  };
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function signToken(payload: Record<string, unknown>): string {
  if (JWT_SECRET.length < 32) throw new Error('Authentication secret is not configured securely.');
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token: string): Record<string, any> | null {
  try {
    const [header, body, signature] = token.split('.');
    if (!header || !body || !signature) return null;
    const expected = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function login(username: string, password: string): { token: string; user: AuthUser } | null {
  const user = getUser(username);
  if (!user || !user.active) return null;

  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) return null;

  if (!bcrypt.compareSync(password, user.passwordHash)) {
    const failures = user.failedLoginCount + 1;
    const lockedUntil = failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
    db.prepare(`UPDATE avclpr_users SET failed_login_count=?, locked_until=?, updated_at=? WHERE id=?`)
      .run(failures, lockedUntil, new Date().toISOString(), user.id);
    return null;
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE avclpr_users SET failed_login_count=0, locked_until=NULL, last_login_at=?, updated_at=? WHERE id=?`)
    .run(now, now, user.id);

  const token = signToken({ sub: user.id, username: user.username, role: user.role, exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 });
  return { token, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role, active: user.active } };
}

export function authenticateToken(token: string): AuthUser | null {
  const payload = verifyToken(token);
  if (!payload?.sub) return null;
  const row = db.prepare(`SELECT id,username,display_name,role_code,active FROM avclpr_users WHERE id=? LIMIT 1`).get(payload.sub) as any;
  if (!row || !row.active) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role_code, active: Boolean(row.active) };
}

export function hasPermission(role: RoleCode, permission: string): boolean {
  if (role === 'SUPER_ADMIN') return true;
  const row = db.prepare(`SELECT 1 FROM avclpr_role_permissions WHERE role_code=? AND permission_code=?`).get(role, permission);
  return Boolean(row);
}

export function createAuditLog(input: {
  userId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  siteId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
}): void {
  db.prepare(`
    INSERT INTO avclpr_audit_logs(id,user_id,action,resource_type,resource_id,site_id,ip_address,user_agent,metadata_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(
    randomUUID(), input.userId ?? null, input.action, input.resourceType ?? null,
    input.resourceId ?? null, input.siteId ?? null, input.ipAddress ?? null,
    input.userAgent ?? null, input.metadata ? JSON.stringify(input.metadata) : null,
    new Date().toISOString()
  );
}

export function listSites() {
  return db.prepare(`SELECT * FROM avclpr_sites ORDER BY site_code`).all();
}

export function createSite(input: {
  siteCode: string; name: string; road?: string; direction?: string;
  jurisdiction?: string; latitude?: number; longitude?: number;
}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO avclpr_sites(id,site_code,name,road,direction,jurisdiction,latitude,longitude,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.siteCode, input.name, input.road ?? null, input.direction ?? null, input.jurisdiction ?? null, input.latitude ?? null, input.longitude ?? null, 'active', now, now);
  return db.prepare(`SELECT * FROM avclpr_sites WHERE id=?`).get(id);
}

export function listCameras(siteId?: string) {
  if (siteId) return db.prepare(`SELECT * FROM avclpr_cameras WHERE site_id=? ORDER BY camera_code`).all(siteId);
  return db.prepare(`SELECT * FROM avclpr_cameras ORDER BY camera_code`).all();
}

export function createCamera(input: {
  siteId: string; cameraCode: string; name: string; host: string;
  rtspPort?: number; channel?: number; credentialRef?: string;
}) {
  const site = db.prepare(`SELECT id FROM avclpr_sites WHERE id=?`).get(input.siteId);
  if (!site) throw new Error('Site not found.');
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO avclpr_cameras(id,site_id,camera_code,name,host,rtsp_port,channel,credential_ref,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.siteId, input.cameraCode, input.name, input.host, input.rtspPort ?? 554, input.channel ?? 1, input.credentialRef ?? null, 'offline', now, now);
  return db.prepare(`SELECT * FROM avclpr_cameras WHERE id=?`).get(id);
}
