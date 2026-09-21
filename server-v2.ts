import express, { Request, Response, NextFunction } from 'express';
import http from 'node:http';
import dotenv from 'dotenv';
import {
  initializeProductionFoundation, authenticateToken, login, completeMfa, setupMfa, enableMfa,
  revokeSession, revokeAllSessions, hasPermission, canAccessSite, accessibleSiteIds,
  listSites, createSite, listCameras, createCamera, updateCamera, deleteCamera,
  listUsers, createUser, updateUser, setUserSiteAccess, listUserSiteAccess, listAuditLogs, audit,
  listWatchlists, createWatchlist, updateWatchlist, deleteWatchlist, listSessions, getEvidence, recordEvidenceAccess, health, metrics, AuthUser, RoleCode,
} from './src/lib/production-foundation.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.V2_PORT || 3100);
const AI_SERVICE_URL = (process.env.AI_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, '');
const AI_SERVICE_TOKEN = process.env.AI_SERVICE_TOKEN || '';
const REQUIRE_HTTPS = process.env.REQUIRE_HTTPS === 'true';
const authRate = new Map<string,{count:number;reset:number}>();
function allowAuthAttempt(ip:string,limit=20,windowMs=10*60*1000){ const now=Date.now(); const row=authRate.get(ip); if(!row||row.reset<now){authRate.set(ip,{count:1,reset:now+windowMs});return true;} if(row.count>=limit)return false; row.count++; return true; }

if (process.env.NODE_ENV === 'production' && !AI_SERVICE_TOKEN) {
  throw new Error('AI_SERVICE_TOKEN is mandatory in production.');
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true');
app.use(express.json({ limit: '1mb' }));

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(v => v.trim()).filter(Boolean);

app.use((req,res,next) => {
  if (REQUIRE_HTTPS && req.header('x-forwarded-proto') !== 'https' && req.protocol !== 'https') {
    return res.status(400).json({success:false,error:'HTTPS is required.'});
  }
  const origin=req.headers.origin;
  if(origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin',origin);
    res.setHeader('Access-Control-Allow-Credentials','true');
  }
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Request-Id');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self' https:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Cache-Control','no-store');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

interface AuthenticatedRequest extends Request { user?: AuthUser; token?: string; }

async function requireAuth(req:AuthenticatedRequest,res:Response,next:NextFunction){
  const header=req.header('authorization')||'';
  const token=header.startsWith('Bearer ')?header.slice(7):'';
  const user=token?await authenticateToken(token):null;
  if(!user) return res.status(401).json({success:false,error:'Authentication required.'});
  req.user=user;req.token=token;next();
}

function requirePermission(permission:string){
  return async (req:AuthenticatedRequest,res:Response,next:NextFunction)=>{
    if(!req.user || !(await hasPermission(req.user.role,permission))) {
      await audit({userId:req.user?.id,action:'authz.denied',resourceType:'permission',resourceId:permission,ipAddress:req.ip,userAgent:req.header('user-agent')});
      return res.status(403).json({success:false,error:'Insufficient permissions.'});
    }
    next();
  };
}

async function requireSite(req:AuthenticatedRequest,siteId:string){
  if(!req.user) return false;
  return canAccessSite(req.user.id,req.user.role,siteId);
}

function validateString(value:unknown,name:string,min=1,max=160){
  if(typeof value!=='string' || value.trim().length<min || value.trim().length>max) throw new Error(`${name} must be ${min === max ? min : `${min}-${max}`} characters.`);
  return value.trim();
}
function validateUuid(value:unknown,name:string){const s=validateString(value,name,1,64);if(!/^[0-9a-f-]{36}$/i.test(s))throw new Error(`${name} is invalid.`);return s;}
function error(res:Response,e:any,status=400){return res.status(status).json({success:false,error:e?.message||'Request failed.'});}

async function aiRequest(path:string,init:RequestInit={}){
  if(!AI_SERVICE_TOKEN) throw new Error('AI service authentication is not configured.');
  const headers=new Headers(init.headers||{});
  headers.set('X-AI-Service-Token',AI_SERVICE_TOKEN);headers.set('Accept','application/json');
  const response=await fetch(`${AI_SERVICE_URL}${path}`,{...init,headers});
  const text=await response.text();let body:any={};try{body=text?JSON.parse(text):{};}catch{body={error:'Invalid AI service response.'};}
  if(!response.ok)throw new Error(body?.detail||body?.error||`AI service returned ${response.status}`);
  return body;
}

app.get('/api/v2/metrics',requireAuth,requirePermission('system.manage'),async(_req,res)=>{
  const m=await metrics();
  const lines=[
    '# HELP avclpr_active_users Active users',
    '# TYPE avclpr_active_users gauge',
    'avclpr_active_users '+m.users,
    '# HELP avclpr_active_sessions Active server sessions',
    '# TYPE avclpr_active_sessions gauge',
    'avclpr_active_sessions '+m.activeSessions,
    '# HELP avclpr_vehicle_events_total Total vehicle events',
    '# TYPE avclpr_vehicle_events_total counter',
    'avclpr_vehicle_events_total '+m.vehicleEvents,
    '# HELP avclpr_active_alerts Active alerts',
    '# TYPE avclpr_active_alerts gauge',
    'avclpr_active_alerts '+m.activeAlerts,
    '# HELP avclpr_audit_events_24h Audit events in last 24 hours',
    '# TYPE avclpr_audit_events_24h gauge',
    'avclpr_audit_events_24h '+m.auditEvents24h
  ];
  res.type('text/plain').send(lines.join('\n')+'\n');
});

app.get('/api/v2/health',async(_req,res)=>{
  try{return res.json({success:true,system:'AVCLPR',version:'2-production-foundation',status:'online',timestamp:new Date().toISOString(),database:await health()});}
  catch(e:any){return res.status(503).json({success:false,status:'degraded',error:'Database unavailable.'});}
});

app.post('/api/v2/auth/login',async(req,res)=>{
  try{
    if(!allowAuthAttempt(req.ip,20)) return res.status(429).json({success:false,error:'Too many authentication attempts. Try again later.'});
    const username=validateString(req.body?.username,'Username',3,80);
    const password=validateString(req.body?.password,'Password',12,256);
    const result=await login(username,password,req.ip,req.header('user-agent'));
    if(!result){await audit({action:'auth.login.failure',resourceType:'user',ipAddress:req.ip,userAgent:req.header('user-agent')});return res.status(401).json({success:false,error:'Invalid credentials or account locked.'});}
    return res.json({success:true,...result});
  }catch(e){return error(res,e);}
});

app.post('/api/v2/auth/mfa/setup',async(req,res)=>{
  try{const result=await setupMfa(validateString(req.body?.setupToken,'Setup token',40,200));if(!result)return res.status(401).json({success:false,error:'Invalid or expired setup token.'});return res.json({success:true,...result});}catch(e){return error(res,e);}
});

app.post('/api/v2/auth/mfa/verify',async(req,res)=>{\n  if(!allowAuthAttempt(req.ip,10,5*60*1000)) return res.status(429).json({success:false,error:'Too many MFA attempts. Try again later.'});
  try{const result=await enableMfa(validateString(req.body?.setupToken,'Setup token',40,200),validateString(req.body?.code,'MFA code',6,6),req.ip,req.header('user-agent'));if(!result)return res.status(401).json({success:false,error:'Invalid or expired MFA code.'});return res.json({success:true,...result});}catch(e){return error(res,e);}
});

app.post('/api/v2/auth/mfa/challenge',async(req,res)=>{\n  if(!allowAuthAttempt(req.ip,10,5*60*1000)) return res.status(429).json({success:false,error:'Too many MFA attempts. Try again later.'});
  try{const result=await completeMfa(validateString(req.body?.challengeToken,'Challenge token',40,200),validateString(req.body?.code,'MFA code',6,6),req.ip,req.header('user-agent'));if(!result)return res.status(401).json({success:false,error:'Invalid or expired MFA code.'});return res.json({success:true,...result});}catch(e){return error(res,e);}
});

app.get('/api/v2/auth/me',requireAuth,(req:AuthenticatedRequest,res)=>res.json({success:true,user:req.user}));
app.post('/api/v2/auth/logout',requireAuth,async(req:AuthenticatedRequest,res)=>{await revokeSession(req.token!,'logout');await audit({userId:req.user!.id,action:'auth.logout',resourceType:'session',ipAddress:req.ip,userAgent:req.header('user-agent')});res.json({success:true});});
app.get('/api/v2/auth/sessions',requireAuth,async(req:AuthenticatedRequest,res)=>res.json({success:true,sessions:await listSessions(req.user!.id)}));
app.delete('/api/v2/auth/sessions',requireAuth,async(req:AuthenticatedRequest,res)=>{await revokeAllSessions(req.user!.id,'user_revoke_all');res.json({success:true});});

app.get('/api/v2/sites',requireAuth,requirePermission('sites.read'),async(req:AuthenticatedRequest,res)=>res.json({success:true,sites:await listSites(req.user!.id,req.user!.role)}));
app.post('/api/v2/sites',requireAuth,requirePermission('sites.write'),async(req:AuthenticatedRequest,res)=>{try{const site=await createSite({siteCode:validateString(req.body?.siteCode,'Site code',2,32),name:validateString(req.body?.name,'Name',2,160),road:req.body?.road,direction:req.body?.direction,jurisdiction:req.body?.jurisdiction,latitude:req.body?.latitude==null?null:Number(req.body.latitude),longitude:req.body?.longitude==null?null:Number(req.body.longitude)});await audit({userId:req.user!.id,action:'site.create',resourceType:'site',resourceId:site.id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.status(201).json({success:true,site});}catch(e){error(res,e);}});

app.get('/api/v2/cameras',requireAuth,requirePermission('cameras.read'),async(req:AuthenticatedRequest,res)=>{try{const siteId=req.query.siteId?validateUuid(req.query.siteId,'siteId'):undefined;if(siteId && !(await requireSite(req,siteId)))return res.status(403).json({success:false,error:'Site access denied.'});res.json({success:true,cameras:await listCameras(req.user!.id,req.user!.role,siteId)});}catch(e){error(res,e);}});
app.post('/api/v2/cameras',requireAuth,requirePermission('cameras.write'),async(req:AuthenticatedRequest,res)=>{try{const siteId=validateUuid(req.body?.siteId,'siteId');if(!(await requireSite(req,siteId)))return res.status(403).json({success:false,error:'Site access denied.'});const camera=await createCamera({siteId,cameraCode:validateString(req.body?.cameraCode,'Camera code',2,64),name:validateString(req.body?.name,'Name',2,160),host:validateString(req.body?.host,'Host',1,255),rtspPort:Number(req.body?.rtspPort||554),channel:Number(req.body?.channel||1),credentialRef:req.body?.credentialRef,mainStream:req.body?.mainStream,aiStream:req.body?.aiStream,previewStream:req.body?.previewStream});await audit({userId:req.user!.id,action:'camera.create',resourceType:'camera',resourceId:camera.id,siteId,ipAddress:req.ip,userAgent:req.header('user-agent')});res.status(201).json({success:true,camera});}catch(e){error(res,e);}});
app.patch('/api/v2/cameras/:id',requireAuth,requirePermission('cameras.write'),async(req:AuthenticatedRequest,res)=>{try{const id=validateUuid(req.params.id,'cameraId');const cameras=await listCameras(req.user!.id,req.user!.role);const camera=cameras.find((x:any)=>x.id===id);if(!camera)return res.status(404).json({success:false,error:'Camera not found.'});const updated=await updateCamera(id,req.body||{});await audit({userId:req.user!.id,action:'camera.update',resourceType:'camera',resourceId:id,siteId:camera.site_id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.json({success:true,camera:updated});}catch(e){error(res,e);}});
app.delete('/api/v2/cameras/:id',requireAuth,requirePermission('cameras.write'),async(req:AuthenticatedRequest,res)=>{try{const id=validateUuid(req.params.id,'cameraId');const cameras=await listCameras(req.user!.id,req.user!.role);const camera=cameras.find((x:any)=>x.id===id);if(!camera)return res.status(404).json({success:false,error:'Camera not found.'});await deleteCamera(id);await audit({userId:req.user!.id,action:'camera.delete',resourceType:'camera',resourceId:id,siteId:camera.site_id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.json({success:true});}catch(e){error(res,e);}});

async function fetchScoped(path:string,siteIds:string[]|null){
  if(siteIds===null)return aiRequest(path);
  if(!siteIds.length)return {events:[],alerts:[]};
  const results=await Promise.all(siteIds.map(id=>aiRequest(`${path}${path.includes('?')?'&':'?'}site_id=${encodeURIComponent(id)}`)));
  if(path.startsWith('/v1/events'))return {success:true,events:results.flatMap(x=>x.events||[])};
  return {success:true,alerts:results.flatMap(x=>x.alerts||[])};
}
app.get('/api/v2/events',requireAuth,requirePermission('events.read'),async(req:AuthenticatedRequest,res)=>{try{const limit=Math.min(Math.max(Number(req.query.limit||100),1),500);const siteId=req.query.siteId?validateUuid(req.query.siteId,'siteId'):undefined;if(siteId&&!(await requireSite(req,siteId)))return res.status(403).json({success:false,error:'Site access denied.'});const ids=siteId?[siteId]:await accessibleSiteIds(req.user!.id,req.user!.role);const body=await fetchScoped(`/v1/events?limit=${limit}`,ids);res.json(body);}catch(e){error(res,e,503);}});
app.get('/api/v2/alerts',requireAuth,requirePermission('alerts.read'),async(req:AuthenticatedRequest,res)=>{try{const ids=await accessibleSiteIds(req.user!.id,req.user!.role);const body=await fetchScoped(`/v1/alerts?limit=500&status=${encodeURIComponent(String(req.query.status||'active'))}`,ids);res.json(body);}catch(e){error(res,e,503);}});
app.post('/api/v2/alerts/:alertId/acknowledge',requireAuth,requirePermission('alerts.manage'),async(req:AuthenticatedRequest,res)=>{try{const body=await aiRequest(`/v1/alerts/${encodeURIComponent(req.params.alertId)}/acknowledge?user_id=${encodeURIComponent(req.user!.id)}`,{method:'POST'});await audit({userId:req.user!.id,action:'alert.acknowledge',resourceType:'alert',resourceId:req.params.alertId,ipAddress:req.ip,userAgent:req.header('user-agent')});res.json(body);}catch(e){error(res,e,503);}});

app.get('/api/v2/evidence/:id',requireAuth,requirePermission('evidence.read'),async(req:AuthenticatedRequest,res)=>{
  try{
    const evidence=await getEvidence(validateUuid(req.params.id,'evidenceId'));
    if(!evidence)return res.status(404).json({success:false,error:'Evidence not found.'});
    if(!(await requireSite(req,evidence.site_id)))return res.status(403).json({success:false,error:'Site access denied.'});
    await recordEvidenceAccess(evidence.id,req.user!.id,'view',req.ip,req.header('user-agent'));
    await audit({userId:req.user!.id,action:'evidence.view',resourceType:'evidence',resourceId:evidence.id,siteId:evidence.site_id,ipAddress:req.ip,userAgent:req.header('user-agent')});
    res.json({success:true,evidence:{id:evidence.id,event_id:evidence.event_id,evidence_type:evidence.evidence_type,sha256_hash:evidence.sha256_hash,size_bytes:evidence.size_bytes,captured_at:evidence.captured_at,retention_until:evidence.retention_until}});
  }catch(e){error(res,e);}
});

app.get('/api/v2/watchlists',requireAuth,requirePermission('watchlists.read'),async(_req,res)=>res.json({success:true,watchlists:await listWatchlists()}));
app.post('/api/v2/watchlists',requireAuth,requirePermission('watchlists.write'),async(req:AuthenticatedRequest,res)=>{try{const item=await createWatchlist(req.body||{},req.user!.id);await audit({userId:req.user!.id,action:'watchlist.create',resourceType:'watchlist',resourceId:item.id,ipAddress:req.ip,userAgent:req.header('user-agent'),metadata:{category:item.category}});res.status(201).json({success:true,watchlist:item});}catch(e){error(res,e);}});
app.patch('/api/v2/watchlists/:id',requireAuth,requirePermission('watchlists.write'),async(req:AuthenticatedRequest,res)=>{try{const id=validateUuid(req.params.id,'watchlistId');const item=await updateWatchlist(id,req.body||{});if(!item)return res.status(404).json({success:false,error:'Watchlist entry not found.'});await audit({userId:req.user!.id,action:'watchlist.update',resourceType:'watchlist',resourceId:id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.json({success:true,watchlist:item});}catch(e){error(res,e);}});
app.delete('/api/v2/watchlists/:id',requireAuth,requirePermission('watchlists.write'),async(req:AuthenticatedRequest,res)=>{try{const id=validateUuid(req.params.id,'watchlistId');await deleteWatchlist(id);await audit({userId:req.user!.id,action:'watchlist.delete',resourceType:'watchlist',resourceId:id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.json({success:true});}catch(e){error(res,e);}});

app.get('/api/v2/users',requireAuth,requirePermission('users.read'),async(_req,res)=>res.json({success:true,users:await listUsers()}));
app.post('/api/v2/users',requireAuth,requirePermission('users.write'),async(req:AuthenticatedRequest,res)=>{try{const u=await createUser({username:validateString(req.body?.username,'Username',3,80),displayName:validateString(req.body?.displayName,'Display name',2,160),role:validateString(req.body?.role,'Role',2,64) as RoleCode,password:validateString(req.body?.password,'Password',12,256),active:req.body?.active!==false});await audit({userId:req.user!.id,action:'user.create',resourceType:'user',resourceId:u.id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.status(201).json({success:true,user:u});}catch(e){error(res,e);}});
app.patch('/api/v2/users/:id',requireAuth,requirePermission('users.write'),async(req:AuthenticatedRequest,res)=>{try{const id=validateUuid(req.params.id,'userId');const u=await updateUser(id,req.body||{});if(!u)return res.status(404).json({success:false,error:'User not found.'});if(req.body?.active===false||req.body?.role)await revokeAllSessions(id,'account_changed');await audit({userId:req.user!.id,action:'user.update',resourceType:'user',resourceId:id,ipAddress:req.ip,userAgent:req.header('user-agent')});res.json({success:true,user:u});}catch(e){error(res,e);}});
app.get('/api/v2/users/:id/sites',requireAuth,requirePermission('users.read'),async(req,res)=>{try{res.json({success:true,siteIds:await listUserSiteAccess(validateUuid(req.params.id,'userId'))});}catch(e){error(res,e);}});
app.put('/api/v2/users/:id/sites',requireAuth,requirePermission('users.write'),async(req:AuthenticatedRequest,res)=>{try{const id=validateUuid(req.params.id,'userId');const siteIds=Array.isArray(req.body?.siteIds)?req.body.siteIds.map((x:any)=>validateUuid(x,'siteId')):[];await setUserSiteAccess(id,siteIds);await revokeAllSessions(id,'site_access_changed');await audit({userId:req.user!.id,action:'user.site_access.update',resourceType:'user',resourceId:id,ipAddress:req.ip,userAgent:req.header('user-agent'),metadata:{siteCount:siteIds.length}});res.json({success:true,siteIds});}catch(e){error(res,e);}});

app.get('/api/v2/audit',requireAuth,requirePermission('audit.read'),async(req,res)=>res.json({success:true,...await listAuditLogs({limit:req.query.limit,offset:req.query.offset})}));

app.get('/api/v2/system/edge-status',requireAuth,requirePermission('dashboard.read'),async(_req,res)=>{try{const body=await aiRequest('/health');res.json({success:true,...body});}catch(e){error(res,e,503);}});
app.post('/api/v2/system/sync/run',requireAuth,requirePermission('system.manage'),async(req:AuthenticatedRequest,res)=>{try{const body=await aiRequest('/v1/sync/run',{method:'POST'});await audit({userId:req.user!.id,action:'sync.run',resourceType:'system',ipAddress:req.ip,userAgent:req.header('user-agent')});res.json(body);}catch(e){error(res,e,503);}});

app.use((err:any,_req:Request,res:Response,_next:NextFunction)=>{console.error('[API]',err);res.status(500).json({success:false,error:'Internal server error.'});});

const server=http.createServer(app);
async function start(){
  await initializeProductionFoundation();
  server.listen(PORT,'0.0.0.0',()=>console.log(`AVCLPR production API listening on :${PORT}`));
}
start().catch(err=>{console.error('[FATAL] API startup failed:',err);process.exit(1);});
