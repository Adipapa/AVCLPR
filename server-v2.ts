import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import dotenv from 'dotenv';
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
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions.' });
    }
    next();
  };
}

function audit(req: AuthenticatedRequest, action: string, resourceType?: string, resourceId?: string) {
  createAuditLog({
    userId: req.user?.id,
    action,
    resourceType,
    resourceId,
    ipAddress: req.ip,
    userAgent: req.header('user-agent'),
  });
}

app.get('/api/v2/health', (_req, res) => {
  res.json({ success: true, system: 'AVCLPR', version: '2-foundation', status: 'online', timestamp: new Date().toISOString() });
});

/* ---------------------------------------------------------
   ONE-TIME ADMIN BOOTSTRAP
   Requires AVCLPR_BOOTSTRAP_SECRET. Never expose that secret
   to the browser or commit it to the repository.
--------------------------------------------------------- */
app.post('/api/v2/auth/bootstrap', (req, res) => {
  try {
    const user = bootstrapAdmin({
      bootstrapSecret: String(req.body?.bootstrapSecret || ''),
      username: String(req.body?.username || '').trim(),
      displayName: String(req.body?.displayName || '').trim(),
      password: String(req.body?.password || ''),
    });
    return res.status(201).json({ success: true, user });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error?.message || 'Bootstrap failed.' });
  }
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

app.get('/api/v2/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ success: true, user: req.user });
});

app.get('/api/v2/sites', requireAuth, requirePermission('sites.read'), (req: AuthenticatedRequest, res) => {
  res.json({ success: true, sites: listSites() });
});

app.post('/api/v2/sites', requireAuth, requirePermission('sites.write'), (req: AuthenticatedRequest, res) => {
  try {
    const site = createSite({
      siteCode: String(req.body?.siteCode || '').trim(),
      name: String(req.body?.name || '').trim(),
      road: req.body?.road,
      direction: req.body?.direction,
      jurisdiction: req.body?.jurisdiction,
      latitude: req.body?.latitude == null ? undefined : Number(req.body.latitude),
      longitude: req.body?.longitude == null ? undefined : Number(req.body.longitude),
    });
    audit(req, 'site.create', 'site', String((site as any).id));
    res.status(201).json({ success: true, site });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Failed to create site.' });
  }
});

app.get('/api/v2/cameras', requireAuth, requirePermission('cameras.read'), (req, res) => {
  const siteId = typeof req.query.siteId === 'string' ? req.query.siteId : undefined;
  res.json({ success: true, cameras: listCameras(siteId) });
});

app.post('/api/v2/cameras', requireAuth, requirePermission('cameras.write'), (req: AuthenticatedRequest, res) => {
  try {
    const camera = createCamera({
      siteId: String(req.body?.siteId || ''),
      cameraCode: String(req.body?.cameraCode || '').trim(),
      name: String(req.body?.name || '').trim(),
      host: String(req.body?.host || '').trim(),
      rtspPort: req.body?.rtspPort == null ? undefined : Number(req.body.rtspPort),
      channel: req.body?.channel == null ? undefined : Number(req.body.channel),
      credentialRef: req.body?.credentialRef,
    });
    audit(req, 'camera.create', 'camera', String((camera as any).id));
    res.status(201).json({ success: true, camera });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error?.message || 'Failed to create camera.' });
  }
});

app.get('/api/v2/audit', requireAuth, requirePermission('audit.read'), (_req, res) => {
  // Audit querying will be added with the central PostgreSQL repository layer.
  res.json({ success: true, logs: [], note: 'Central audit query is reserved for PostgreSQL.' });
});

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`AVCLPR v2 foundation API listening on http://localhost:${PORT}`);
});
