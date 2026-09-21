import { randomBytes, createHash, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

export type RoleCode = 'SUPER_ADMIN'|'NATIONAL_ADMIN'|'POLICE'|'TRANSPORT'|'PURA'|'GICTA'|'INTELLIGENCE'|'ANALYST'|'OPERATOR'|'VIEW_ONLY';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: RoleCode;
  active: boolean;
  mfaEnabled: boolean;
}

const DATABASE_URL = process.env.DATABASE_URL || '';
const AUTH_SECRET = process.env.AVCLPR_AUTH_SECRET || '';
const MFA_KEY_SOURCE = process.env.AVCLPR_MFA_ENCRYPTION_KEY || AUTH_SECRET;
const SESSION_HOURS = Number(process.env.AVCLPR_SESSION_HOURS || 8);
const IDLE_MINUTES = Number(process.env.AVCLPR_SESSION_IDLE_MINUTES || 30);

if (process.env.NODE_ENV === 'production') {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
  if (AUTH_SECRET.length < 32) throw new Error('AVCLPR_AUTH_SECRET must be at least 32 characters.');
  if (!process.env.AVCLPR_MFA_ENCRYPTION_KEY) throw new Error('AVCLPR_MFA_ENCRYPTION_KEY is required in production.');
}

export const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
});

const ROLES: Array<[RoleCode,string]> = [
  ['SUPER_ADMIN','Super Administrator'],['NATIONAL_ADMIN','National Administrator'],['POLICE','Police'],
  ['TRANSPORT','Transport'],['PURA','PURA'],['GICTA','GICTA'],['INTELLIGENCE','Intelligence'],
  ['ANALYST','Analyst'],['OPERATOR','Operator'],['VIEW_ONLY','View Only'],
];

const PERMISSIONS = [
  'dashboard.read','sites.read','sites.write','cameras.read','cameras.write','events.read','events.export',
  'evidence.read','evidence.export','watchlists.read','watchlists.write','alerts.read','alerts.manage',
  'reports.read','reports.export','users.read','users.write','audit.read','system.manage',
];

const ROLE_PERMISSIONS: Record<RoleCode,string[]> = {
  SUPER_ADMIN: PERMISSIONS,
  NATIONAL_ADMIN: ['dashboard.read','sites.read','sites.write','cameras.read','cameras.write','events.read','events.export','evidence.read','evidence.export','watchlists.read','watchlists.write','alerts.read','alerts.manage','reports.read','reports.export','users.read','users.write','audit.read','system.manage'],
  POLICE: ['dashboard.read','sites.read','cameras.read','events.read','events.export','evidence.read','evidence.export','watchlists.read','watchlists.write','alerts.read','alerts.manage','reports.read','reports.export'],
  TRANSPORT: ['dashboard.read','sites.read','cameras.read','events.read','events.export','evidence.read','reports.read','reports.export'],
  PURA: ['dashboard.read','sites.read','cameras.read','events.read','reports.read'],
  GICTA: ['dashboard.read','sites.read','sites.write','cameras.read','cameras.write','events.read','system.manage','audit.read'],
  INTELLIGENCE: ['dashboard.read','sites.read','cameras.read','events.read','evidence.read','evidence.export','watchlists.read','watchlists.write','alerts.read','alerts.manage','reports.read'],
  ANALYST: ['dashboard.read','sites.read','cameras.read','events.read','events.export','reports.read','reports.export'],
  OPERATOR: ['dashboard.read','sites.read','cameras.read','events.read','alerts.read','alerts.manage'],
  VIEW_ONLY: ['dashboard.read','sites.read','cameras.read','events.read','alerts.read','reports.read'],
};

export async function initializeProductionFoundation(): Promise<void> {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required. SQLite is no longer an authoritative production control plane.');
  for (const [code,name] of ROLES) await pool.query('INSERT INTO roles(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name',[code,name]);
  for (const permission of PERMISSIONS) await pool.query('INSERT INTO permissions(code,description) VALUES($1,$1) ON CONFLICT(code) DO NOTHING',[permission]);
  for (const role of ROLES.map(x=>x[0])) {
    await pool.query(
      'INSERT INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r CROSS JOIN permissions p WHERE r.code=$1 AND p.code=ANY($2::text[]) ON CONFLICT DO NOTHING',
      [role, ROLE_PERMISSIONS[role]]
    );
  }
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function newToken(): string { return randomBytes(32).toString('base64url'); }

function mfaKey(): Buffer {
  return createHash('sha256').update(MFA_KEY_SOURCE).digest();
}

function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',mfaKey(),iv);
  const encrypted = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return [iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}

function decryptSecret(value: string): string {
  const [ivB64,tagB64,dataB64] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm',mfaKey(),Buffer.from(ivB64,'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64,'base64url')),decipher.final()]).toString('utf8');
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(bytes: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value=(value<<8)|byte; bits+=8; while(bits>=5){ out+=B32[(value>>>(bits-5))&31]; bits-=5; } }
  if(bits>0) out+=B32[(value<<(5-bits))&31];
  return out;
}
function base32Decode(input: string): Buffer {
  let bits=0,value=0; const out:number[]=[];
  for(const ch of input.replace(/=+$/,'').toUpperCase()){ const n=B32.indexOf(ch); if(n<0) throw new Error('Invalid MFA secret.'); value=(value<<5)|n; bits+=5; if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;} }
  return Buffer.from(out);
}
function totp(secret: string, counter: number): string {
  const key=base32Decode(secret), buf=Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest=createHmac('sha1',key).update(buf).digest();
  const offset=digest[digest.length-1]&15;
  const code=((digest[offset]&127)<<24|(digest[offset+1]<<16)|(digest[offset+2]<<8)|digest[offset+3])%1000000;
  return String(code).padStart(6,'0');
}
function verifyTotp(secret:string, code:string):boolean {
  if(!/^\d{6}$/.test(code)) return false;
  const counter=Math.floor(Date.now()/30000);
  for(let delta=-1;delta<=1;delta++){ const expected=totp(secret,counter+delta); if(timingSafeEqual(Buffer.from(expected),Buffer.from(code))) return true; }
  return false;
}

async function rowToUser(row:any): Promise<AuthUser> {
  return {id:row.id,username:row.username,displayName:row.display_name,role:row.role_code,active:row.active,mfaEnabled:row.mfa_enabled};
}

async function userById(id:string):Promise<any|null> {
  const r=await pool.query(`SELECT u.*,r.code AS role_code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=$1 LIMIT 1`,[id]);
  return r.rows[0]||null;
}
async function userByUsername(username:string):Promise<any|null> {
  const r=await pool.query(`SELECT u.*,r.code AS role_code FROM users u JOIN roles r ON r.id=u.role_id WHERE u.username=$1 LIMIT 1`,[username]);
  return r.rows[0]||null;
}

export async function login(username:string,password:string,ip?:string,userAgent?:string):Promise<any|null>{
  const user=await userByUsername(username);
  if(!user || !user.active) return null;
  if(user.locked_until && new Date(user.locked_until).getTime()>Date.now()) return null;
  const ok=await bcrypt.compare(password,user.password_hash);
  if(!ok){
    const failures=Number(user.failed_login_count||0)+1;
    const locked=failures>=5?new Date(Date.now()+15*60*1000):null;
    await pool.query('UPDATE users SET failed_login_count=$1,locked_until=$2,updated_at=now() WHERE id=$3',[failures,locked,user.id]);
    await audit({action:'auth.login.failure',resourceType:'user',resourceId:user.id,ipAddress:ip,userAgent,metadata:{reason:'invalid_credentials',failures}});
    return null;
  }
  await pool.query('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=now(),updated_at=now() WHERE id=$1',[user.id]);
  const privileged=['SUPER_ADMIN','NATIONAL_ADMIN','GICTA','INTELLIGENCE'].includes(user.role_code);
  if(privileged && !user.mfa_enabled){
    const challenge=newToken();
    await pool.query('INSERT INTO mfa_challenges(user_id,challenge_hash,ip_address,user_agent,expires_at) VALUES($1,$2,$3,$4,now()+interval \'10 minutes\')',[user.id,hashToken(challenge),ip||null,userAgent||null]);
    return {mfaSetupRequired:true,setupToken:challenge,user:await rowToUser(user)};
  }
  if(privileged && user.mfa_enabled){
    const challenge=newToken();
    await pool.query('INSERT INTO mfa_challenges(user_id,challenge_hash,ip_address,user_agent,expires_at) VALUES($1,$2,$3,$4,now()+interval \'5 minutes\')',[user.id,hashToken(challenge),ip||null,userAgent||null]);
    return {mfaRequired:true,challengeToken:challenge,user:await rowToUser(user)};
  }
  const session=await createSession(user.id,ip,userAgent);
  await audit({userId:user.id,action:'auth.login.success',resourceType:'user',resourceId:user.id,ipAddress:ip,userAgent});
  return {token:session.token,user:await rowToUser(user)};
}

async function createSession(userId:string,ip?:string,userAgent?:string){
  const token=newToken();
  const max= new Date(Date.now()+SESSION_HOURS*60*60*1000);
  await pool.query('INSERT INTO user_sessions(user_id,token_hash,ip_address,user_agent,expires_at) VALUES($1,$2,$3,$4,$5)',[userId,hashToken(token),ip||null,userAgent||null,max]);
  return {token,expiresAt:max.toISOString()};
}

export async function completeMfa(challengeToken:string,code:string,ip?:string,userAgent?:string){
  const r=await pool.query(`SELECT c.*,u.*,r.code AS role_code FROM mfa_challenges c JOIN users u ON u.id=c.user_id JOIN roles r ON r.id=u.role_id WHERE c.challenge_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() LIMIT 1`,[hashToken(challengeToken)]);
  const row=r.rows[0]; if(!row) return null;
  if(!verifyTotp(decryptSecret(row.mfa_secret_enc),code)) return null;
  await pool.query('UPDATE mfa_challenges SET consumed_at=now() WHERE id=$1',[row.id]);
  const session=await createSession(row.user_id,ip,userAgent);
  await audit({userId:row.user_id,action:'auth.mfa.success',resourceType:'user',resourceId:row.user_id,ipAddress:ip,userAgent});
  return {token:session.token,user:await rowToUser(row)};
}

export async function setupMfa(setupToken:string):Promise<{secret:string;otpauthUrl:string}|null>{
  const r=await pool.query(`SELECT c.*,u.username FROM mfa_challenges c JOIN users u ON u.id=c.user_id WHERE c.challenge_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() LIMIT 1`,[hashToken(setupToken)]);
  const row=r.rows[0]; if(!row) return null;
  const secret=base32Encode(randomBytes(20));
  await pool.query('UPDATE users SET mfa_secret_enc=$1,updated_at=now() WHERE id=$2',[encryptSecret(secret),row.user_id]);
  const issuer='QTS-AVCLPR';
  const otpauthUrl=`otpauth://totp/${encodeURIComponent(issuer+':'+row.username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return {secret,otpauthUrl};
}

export async function enableMfa(setupToken:string,code:string,ip?:string,userAgent?:string){
  const r=await pool.query(`SELECT c.*,u.mfa_secret_enc FROM mfa_challenges c JOIN users u ON u.id=c.user_id WHERE c.challenge_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() LIMIT 1`,[hashToken(setupToken)]);
  const row=r.rows[0]; if(!row||!row.mfa_secret_enc) return null;
  if(!verifyTotp(decryptSecret(row.mfa_secret_enc),code)) return null;
  await pool.query('UPDATE users SET mfa_enabled=true,mfa_enrolled_at=now(),updated_at=now() WHERE id=$1',[row.user_id]);
  await pool.query('UPDATE mfa_challenges SET consumed_at=now() WHERE id=$1',[row.id]);
  const user=await userById(row.user_id); const session=await createSession(row.user_id,ip,userAgent);
  await audit({userId:row.user_id,action:'auth.mfa.enabled',resourceType:'user',resourceId:row.user_id,ipAddress:ip,userAgent});
  return {token:session.token,user:await rowToUser(user)};
}

export async function authenticateToken(token:string):Promise<AuthUser|null>{
  if(!token) return null;
  const r=await pool.query(`SELECT s.*,u.username,u.display_name,u.active,u.mfa_enabled,r.code AS role_code FROM user_sessions s JOIN users u ON u.id=s.user_id JOIN roles r ON r.id=u.role_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.last_seen_at>now()-make_interval(mins=>$2) LIMIT 1`,[hashToken(token),IDLE_MINUTES]);
  const row=r.rows[0]; if(!row||!row.active) return null;
  await pool.query('UPDATE user_sessions SET last_seen_at=now() WHERE id=$1',[row.id]);
  return {id:row.user_id,username:row.username,displayName:row.display_name,role:row.role_code,active:row.active,mfaEnabled:row.mfa_enabled};
}

export async function revokeSession(token:string,reason='logout'){ await pool.query('UPDATE user_sessions SET revoked_at=now(),revoked_reason=$1 WHERE token_hash=$2 AND revoked_at IS NULL',[reason,hashToken(token)]); }
export async function revokeAllSessions(userId:string,reason='admin_revoke'){ await pool.query('UPDATE user_sessions SET revoked_at=now(),revoked_reason=$1 WHERE user_id=$2 AND revoked_at IS NULL',[reason,userId]); }

export async function hasPermission(role:RoleCode,permission:string){ return (ROLE_PERMISSIONS[role]||[]).includes(permission); }

export async function canAccessSite(userId:string,role:RoleCode,siteId:string):Promise<boolean>{
  if(role==='SUPER_ADMIN'||role==='NATIONAL_ADMIN') return true;
  const r=await pool.query('SELECT 1 FROM user_site_access WHERE user_id=$1 AND site_id=$2 LIMIT 1',[userId,siteId]);
  return Boolean(r.rowCount);
}

export async function accessibleSiteIds(userId:string,role:RoleCode):Promise<string[]|null>{
  if(role==='SUPER_ADMIN'||role==='NATIONAL_ADMIN') return null;
  const r=await pool.query('SELECT site_id FROM user_site_access WHERE user_id=$1',[userId]);
  return r.rows.map(x=>x.site_id);
}

export async function listSites(userId?:string,role?:RoleCode){
  const ids=userId&&role?await accessibleSiteIds(userId,role):null;
  if(ids===null) return (await pool.query('SELECT * FROM sites ORDER BY site_code')).rows;
  if(!ids?.length) return [];
  return (await pool.query('SELECT * FROM sites WHERE id=ANY($1::uuid[]) ORDER BY site_code',[ids])).rows;
}

export async function createSite(input:any){
  const r=await pool.query('INSERT INTO sites(site_code,name,road,direction,jurisdiction,latitude,longitude) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[input.siteCode,input.name,input.road||null,input.direction||null,input.jurisdiction||null,input.latitude??null,input.longitude??null]);
  return r.rows[0];
}

export async function listCameras(userId?:string,role?:RoleCode,siteId?:string){
  const ids=userId&&role?await accessibleSiteIds(userId,role):null;
  const clauses:string[]=[]; const args:any[]=[]; let n=1;
  if(siteId){clauses.push(`site_id=$${n++}`);args.push(siteId);}
  if(ids!==null){if(!ids?.length)return [];clauses.push(`site_id=ANY($${n++}::uuid[])`);args.push(ids);}
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
  return (await pool.query(`SELECT * FROM cameras ${where} ORDER BY camera_code`,args)).rows;
}

export async function createCamera(input:any){
  const r=await pool.query('INSERT INTO cameras(site_id,camera_code,name,host,rtsp_port,channel,credential_ref,main_stream,ai_stream,preview_stream) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[input.siteId,input.cameraCode,input.name,input.host,input.rtspPort||554,input.channel||1,input.credentialRef||null,input.mainStream||null,input.aiStream||null,input.previewStream||null]);
  return r.rows[0];
}

export async function listUsers(){ return (await pool.query('SELECT u.id,u.username,u.display_name,u.active,u.mfa_enabled,u.created_at,u.last_login_at,r.code AS role_code,r.name AS role_name FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.username')).rows; }

export async function createUser(input:any){
  const role=await pool.query('SELECT id,code FROM roles WHERE code=$1',[input.role]);
  if(!role.rows[0]) throw new Error('Invalid role.');
  const passwordHash=await bcrypt.hash(input.password,12);
  const r=await pool.query('INSERT INTO users(username,display_name,password_hash,role_id,active) VALUES($1,$2,$3,$4,$5) RETURNING id,username,display_name,active,mfa_enabled,created_at',[input.username,input.displayName,passwordHash,role.rows[0].id,input.active!==false]);
  return {...r.rows[0],role_code:role.rows[0].code};
}

export async function updateUser(id:string,input:any){
  const fields:string[]=[];const args:any[]=[];let n=1;
  if(input.displayName!==undefined){fields.push(`display_name=$${n++}`);args.push(input.displayName);}
  if(input.active!==undefined){fields.push(`active=$${n++}`);args.push(Boolean(input.active));}
  if(input.role!==undefined){const role=await pool.query('SELECT id FROM roles WHERE code=$1',[input.role]);if(!role.rows[0])throw new Error('Invalid role.');fields.push(`role_id=$${n++}`);args.push(role.rows[0].id);}
  if(input.password){fields.push(`password_hash=$${n++}`);args.push(await bcrypt.hash(input.password,12));}
  if(!fields.length)return (await pool.query('SELECT id,username,display_name,active,mfa_enabled FROM users WHERE id=$1',[id])).rows[0];
  args.push(id);return (await pool.query(`UPDATE users SET ${fields.join(',')},updated_at=now() WHERE id=$${n} RETURNING id,username,display_name,active,mfa_enabled`,args)).rows[0];
}

export async function setUserSiteAccess(userId:string,siteIds:string[]){ const client=await pool.connect(); try{await client.query('BEGIN');await client.query('DELETE FROM user_site_access WHERE user_id=$1',[userId]);for(const siteId of siteIds)await client.query('INSERT INTO user_site_access(user_id,site_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[userId,siteId]);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();} }

export async function listUserSiteAccess(userId:string){ return (await pool.query('SELECT site_id FROM user_site_access WHERE user_id=$1',[userId])).rows.map(x=>x.site_id); }

export async function listAuditLogs(input:any={}){const limit=Math.min(Math.max(Number(input.limit||100),1),500);const offset=Math.max(Number(input.offset||0),0);const ids=input.userId&&input.role?await accessibleSiteIds(input.userId,input.role):null;const clauses:string[]=[];const args:any[]=[];let n=1;if(ids!==null){if(!ids?.length)return {logs:[],limit,offset};clauses.push(`a.site_id=ANY(${n++}::uuid[])`);args.push(ids);}const where=clauses.length?'WHERE '+clauses.join(' AND '):'';args.push(limit,offset);const r=await pool.query(`SELECT a.*,u.username FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ${where} ORDER BY a.created_at DESC LIMIT ${n++} OFFSET ${n}`,args);return {logs:r.rows,limit,offset};}

export async function audit(input:any){ await pool.query('INSERT INTO audit_logs(user_id,action,resource_type,resource_id,site_id,ip_address,user_agent,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.userId||null,input.action,input.resourceType||null,input.resourceId||null,input.siteId||null,input.ipAddress||null,input.userAgent||null,input.metadata||null]); }

export async function updateCamera(id:string,input:any){
  const fields:string[]=[];const args:any[]=[];let n=1;
  for(const [key,column] of [['name','name'],['host','host'],['rtspPort','rtsp_port'],['channel','channel'],['credentialRef','credential_ref'],['mainStream','main_stream'],['aiStream','ai_stream'],['previewStream','preview_stream'],['status','status']] as const){
    if(input[key]!==undefined){fields.push(`${column}=${n++}`);args.push(input[key]);}
  }
  if(!fields.length)return (await pool.query('SELECT * FROM cameras WHERE id=$1',[id])).rows[0];
  args.push(id);return (await pool.query(`UPDATE cameras SET ${fields.join(',')},updated_at=now() WHERE id=${n} RETURNING *`,args)).rows[0];
}
export async function deleteCamera(id:string){await pool.query('DELETE FROM cameras WHERE id=$1',[id]);}
export async function listWatchlists(){return (await pool.query('SELECT * FROM watchlists WHERE active=true ORDER BY normalized_plate')).rows;}
export async function createWatchlist(input:any,userId:string){
  const normalized=String(input.plateNumber||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!normalized)throw new Error('A valid plate number is required.');
  const r=await pool.query('INSERT INTO watchlists(plate_number,normalized_plate,category,description,vehicle_type,owner_name,notes,alert_enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[String(input.plateNumber).trim().toUpperCase(),normalized,String(input.category||'GENERAL').toUpperCase(),input.description||null,input.vehicleType||null,input.ownerName||null,input.notes||null,input.alertEnabled!==false,userId]);
  return r.rows[0];
}
export async function updateWatchlist(id:string,input:any){
  const fields:string[]=[];const args:any[]=[];let n=1;
  if(input.plateNumber!==undefined){const normalized=String(input.plateNumber).toUpperCase().replace(/[^A-Z0-9]/g,'');fields.push(`plate_number=${n++}`,`normalized_plate=${n++}`);args.push(String(input.plateNumber).trim().toUpperCase(),normalized);}
  for(const [key,column] of [['category','category'],['description','description'],['vehicleType','vehicle_type'],['ownerName','owner_name'],['notes','notes'],['alertEnabled','alert_enabled'],['active','active']] as const){if(input[key]!==undefined){fields.push(`${column}=${n++}`);args.push(input[key]);}}
  if(!fields.length)return (await pool.query('SELECT * FROM watchlists WHERE id=$1',[id])).rows[0];
  args.push(id);return (await pool.query(`UPDATE watchlists SET ${fields.join(',')},updated_at=now() WHERE id=${n} RETURNING *`,args)).rows[0];
}
export async function deleteWatchlist(id:string){await pool.query('UPDATE watchlists SET active=false,updated_at=now() WHERE id=$1',[id]);}
export async function listSessions(userId:string){return (await pool.query('SELECT id,ip_address,user_agent,created_at,last_seen_at,expires_at,revoked_at,revoked_reason FROM user_sessions WHERE user_id=$1 ORDER BY created_at DESC',[userId])).rows;}
export async function getEvidence(id:string){
  const r=await pool.query('SELECT e.*,v.site_id FROM evidence e JOIN vehicle_events v ON v.id=e.event_id WHERE e.id=$1 LIMIT 1',[id]);
  return r.rows[0]||null;
}
export async function recordEvidenceAccess(evidenceId:string,userId:string,action:string,ip?:string,userAgent?:string,purpose?:string){
  await pool.query('INSERT INTO evidence_access_logs(evidence_id,user_id,action,ip_address,user_agent,purpose) VALUES($1,$2,$3,$4,$5,$6)',[evidenceId,userId,action,ip||null,userAgent||null,purpose||null]);
}
export async function metrics(){
  const [users,sessions,events,alerts,auditRows]=await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM users WHERE active=true'),
    pool.query('SELECT COUNT(*)::int AS n FROM user_sessions WHERE revoked_at IS NULL AND expires_at>now()'),
    pool.query('SELECT COUNT(*)::bigint AS n FROM vehicle_events'),
    pool.query('SELECT COUNT(*)::int AS n FROM alerts WHERE status=\'active\''),
    pool.query('SELECT COUNT(*)::bigint AS n FROM audit_logs WHERE created_at>now()-interval \'24 hours\'')
  ]);
  return {users:users.rows[0].n,activeSessions:sessions.rows[0].n,vehicleEvents:events.rows[0].n,activeAlerts:alerts.rows[0].n,auditEvents24h:auditRows.rows[0].n};
}
export async function health(){const r=await pool.query('SELECT now() AS database_time');return {database:'postgresql',connected:true,databaseTime:r.rows[0].database_time};}
