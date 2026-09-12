import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import dotenv from 'dotenv';
import './src/lib/rbac-policy.js';
import { bootstrapIsAvailable } from './src/lib/bootstrap-guard.js';
import {
  authenticateToken,
  bootstrapAdmin,
  createAuditLog,
  createCamera,
  createSite,
  hasPermission,
  listCameras,
  listSites,
  login,
  AuthUser,
} from './src/lib/production-foundation.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.V2_PORT || 3100);
const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
const AI_SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN || '';

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(value => value.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

interface AuthenticatedRequest extends Request { user?: AuthUser }

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = token ? authenticateToken(token) : null;
  if (!user) return res.status(401).json({ success: false, error: 'Authentication required.' });
  req.user = user;
  next();
}

function requirePermission(permission: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !hasPermission(req.user.role, permission)) return res.status(403).json({ success: false, error: 'Insufficient permissions.' });
    next();
  };
}

function audit(req: AuthenticatedRequest, action: string, resourceType?: string, resourceId?: string) {
  createAuditLog({ userId: req.user?.id, action, resourceType, resourceId, ipAddress: req.ip, userAgent: req.header('user-agent') });
}

async function aiRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (AI_SERVICE_TOKEN) headers.set('X-AI-Service-Token', AI_SERVICE_TOKEN);
  headers.set('Accept', 'application/json');
  const response = await fetch(`${AI_SERVICE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.detail || body?.error || `AI service returned ${response.status}`);
  return body;
}

app.get('/api/v2/health', (_req, res) => {
  res.json({ success: true, system: 'AVCLPR', version: '2-foundation', status: 'online', timestamp: new Date().toISOString(), bootstrapAvailable: bootstrapIsAvailable() });
});

app.post('/api/v2/auth/bootstrap', (req, res) => {
  if (!bootstrapIsAvailable()) return res.status(409).json({ success: false, error: 'Administrator bootstrap has already been completed.' });
  try {
    const user = bootstrapAdmin({ bootstrapSecret: String(req.body?.bootstrapSecret || ''), username: String(req.body?.username || '').trim(), displayName: String(req.body?.displayName || '').trim(), password: String(req.body?.password || '') });
    return res.status(201).json({ success: true, user });
  } catch (error: any) { return res.status(400).json({ success: false, error: error?.message || 'Bootstrap failed.' }); }
});

app.post('/api/v2/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) return res.status(400).json({ success: false, error: 'Username and password are required.' });
  const result = login(username, password);
  if (!result) return res.status(401).json({ success: false, error: 'Invalid credentials or account locked.' });
  createAuditLog({ userId: result.user.id, action: 'auth.login', resourceType: 'user', resourceId: result.user.id, ipAddress: req.ip, userAgent: req.header('user-agent') });
  return res.json({ success: true, ...result });
});

app.get('/api/v2/auth/me', requireAuth, (req: AuthenticatedRequest, res) => res.json({ success: true, user: req.user }));

app.get('/api/v2/sites', requireAuth, requirePermission('sites.read'), (_req, res) => res.json({ success: true, sites: listSites() }));

app.post('/api/v2/sites', requireAuth, requirePermission('sites.write'), (req: AuthenticatedRequest, res) => {
  try {
    const site = createSite({ siteCode: String(req.body?.siteCode || '').trim(), name: String(req.body?.name || '').trim(), road: req.body?.road, direction: req.body?.direction, jurisdiction: req.body?.jurisdiction, latitude: req.body?.latitude == null ? undefined : Number(req.body.latitude), longitude: req.body?.longitude == null ? undefined : Number(req.body.longitude) });
    audit(req, 'site.create', 'site', String((site as any).id));
    res.status(201).json({ success: true, site });
  } catch (error: any) { res.status(400).json({ success: false, error: error?.message || 'Failed to create site.' }); }
});

app.get('/api/v2/cameras', requireAuth, requirePermission('cameras.read'), (req, res) => {
  const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : undefined;
  res.json({ success: true, cameras: listCameras(siteId) });
});

app.post('/api/v2/cameras', requireAuth, requirePermission('cameras.write'), (req: AuthenticatedRequest, res) => {
  try {
    const camera = createCamera({ siteId: String(req.body?.siteId || ''), cameraCode: String(req.body?.cameraCode || '').trim(), name: String(req.body?.name || '').trim(), host: String(req.body?.host || '').trim(), rtspPort: req.body?.rtspPort == null ? undefined : Number(req.body.rtspPort), channel: req.body?.channel == null ? undefined : Number(req.body.channel), credentialRef: req.body?.credentialRef });
    audit(req, 'camera.create', 'camera', String((camera as any).id));
    res.status(201).json({ success: true, camera });
  } catch (error: any) { res.status(400).json({ success: false, error: error?.message || 'Failed to create camera.' }); }
});

app.get('/api/v2/events', requireAuth, requirePermission('events.read'), async (req: AuthenticatedRequest, res) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : undefined;
    res.json(await aiRequest(`/v1/events?limit=${Math.max(1, Math.min(limit || 100, 500))}${siteId ? `&site_id=${encodeURIComponent(siteId)}` : ''}`));
  } catch (error: any) { res.status(503).json({ success: false, error: error?.message || 'AI service unavailable.' }); }
});

app.get('/api/v2/alerts', requireAuth, requirePermission('alerts.read'), async (req: AuthenticatedRequest, res) => {
  try {
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const status = typeof req.query.status === 'string' ? req.query.status : 'active';
    res.json(await aiRequest(`/v1/alerts?limit=${Math.max(1, Math.min(limit || 100, 500))}&status=${encodeURIComponent(status)}`));
  } catch (error: any) { res.status(503).json({ success: false, error: error?.message || 'AI service unavailable.' }); }
});

app.post('/api/v2/alerts/:alertId/acknowledge', requireAuth, requirePermission('alerts.manage'), async (req: AuthenticatedRequest, res) => {
  try {
    const body = await aiRequest(`/v1/alerts/${encodeURIComponent(req.params.alertId)}/acknowledge?user_id=${encodeURIComponent(req.user!.id)}`, { method: 'POST' });
    audit(req, 'alert.acknowledge', 'alert', req.params.alertId);
    res.json(body);
  } catch (error: any) { res.status(503).json({ success: false, error: error?.message || 'Failed to acknowledge alert.' }); }
});

app.get('/api/v2/system/edge-status', requireAuth, requirePermission('dashboard.read'), async (_req, res) => {
  try { res.json(await aiRequest('/health')); }
  catch (error: any) { res.status(503).json({ success: false, error: error?.message || 'AI service unavailable.' }); }
});

app.post('/api/v2/system/sync/run', requireAuth, requirePermission('system.manage'), async (req: AuthenticatedRequest, res) => {
  try { const body = await aiRequest('/v1/sync/run', { method: 'POST' }); audit(req, 'sync.run', 'system'); res.json(body); }
  catch (error: any) { res.status(503).json({ success: false, error: error?.message || 'Synchronization failed.' }); }
});

app.get('/api/v2/audit', requireAuth, requirePermission('audit.read'), (_req, res) => res.json({ success: true, logs: [], note: 'Central audit query is reserved for PostgreSQL.' }));

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => console.log(`AVCLPR v2 foundation API listening on http://localhost:${PORT}`));
