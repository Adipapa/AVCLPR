import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity, AlertTriangle, Bell, Car, CheckCircle2, ChevronDown, Circle,
  Database, Gauge, LayoutDashboard, LogOut, Menu, Radio, RefreshCw,
  Search, Shield, Siren, Truck, Users, Video, Wifi, X
} from 'lucide-react';
import './App.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3100/api/v2';

type User = { id: string; username: string; displayName: string; role: string };
type Site = { id: string; site_code?: string; siteCode?: string; name: string; road?: string; status?: string };
type EventItem = { id: string; timestamp: string; plate_number?: string; vehicle_type: string; direction?: string; detection_confidence?: number; watchlist?: boolean; watchlist_category?: string; site_code?: string; site_name?: string; camera_code?: string; camera_name?: string };
type Alert = { id: string; severity: string; title: string; description?: string; status: string; created_at: string; site_code?: string; site_name?: string; camera_code?: string; camera_name?: string };
type Worker = { state: string; connected: boolean; frames_received: number; frames_processed: number; frames_dropped: number; reconnects: number; events_created: number; queue_depth: number; last_error?: string | null };
type EdgeStatus = { status: string; camera_workers?: { count: number; items: Record<string, Worker> }; sync?: { running: boolean; synced_total: number; failed_total: number; queue: { pending: number }; central: { connected: boolean } } };

async function api(path: string, options: RequestInit = {}, token?: string) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.detail || `Request failed (${response.status})`);
  return body;
}

function Login({ onLogin }: { onLogin: (token: string, user: User) => void }) {
  const [username,setUsername]=useState(''); const [password,setPassword]=useState(''); const [code,setCode]=useState('');
  const [setupToken,setSetupToken]=useState(''); const [challengeToken,setChallengeToken]=useState(''); const [secret,setSecret]=useState('');
  const [step,setStep]=useState<'password'|'setup'|'mfa'>('password'); const [error,setError]=useState('');
  const submit=async(event:FormEvent)=>{event.preventDefault();setError('');
    try{
      if(step==='password'){
        const result=await api('/auth/login',{method:'POST',body:JSON.stringify({username,password})});
        if(result.token){onLogin(result.token,result.user);return;}
        if(result.mfaSetupRequired){
          setSetupToken(result.setupToken);
          const setup=await api('/auth/mfa/setup',{method:'POST',body:JSON.stringify({setupToken:result.setupToken})});
          setSecret(setup.secret); setStep('setup'); return;
        }
        if(result.mfaRequired){setChallengeToken(result.challengeToken);setStep('mfa');return;}
      }else if(step==='setup'){
        const result=await api('/auth/mfa/verify',{method:'POST',body:JSON.stringify({setupToken,code})});
        onLogin(result.token,result.user);
      }else{
        const result=await api('/auth/mfa/challenge',{method:'POST',body:JSON.stringify({challengeToken,code})});
        onLogin(result.token,result.user);
      }
    }catch(e){setError(e instanceof Error?e.message:'Authentication failed');}
  };
  return <div className="login-shell">
    <div className="login-art"><div className="radar"/><div className="login-grid"/><div className="login-art-content"><div className="brand-mark"><Shield size={22}/> QTS</div><h1>National Vehicle<br/><span>Intelligence</span> Platform</h1><p>AI-powered highway monitoring, vehicle intelligence and road safety operations.</p><div className="login-status"><span className="pulse"/> SECURE GOVERNMENT OPERATIONS</div></div></div>
    <form onSubmit={submit} className="login-card"><div className="mobile-brand"><Shield size={20}/> QTS AVCLPR</div><div className="eyebrow">SECURE ACCESS</div>
      <h2>{step==='password'?'Sign in to Command Center':step==='setup'?'Set up MFA':'Verify MFA'}</h2>
      <p className="muted">{step==='setup'?'Add the secret to an authenticator app, then enter its six-digit code.':'Authorized personnel only. Activity is logged and audited.'}</p>
      {step==='password'&&<><label>Username<input placeholder="Enter username" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username"/></label><label>Password<input placeholder="Enter password" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label></>}
      {step==='setup'&&<><label>Authenticator secret<input value={secret} readOnly/></label><label>6-digit code<input inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></label></>}
      {step==='mfa'&&<label>Authenticator code<input autoFocus inputMode="numeric" maxLength={6} value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/></label>}
      <button className="primary full-btn">{step==='password'?'SIGN IN':step==='setup'?'ENABLE MFA':'VERIFY MFA'} <span>→</span></button>
      {error&&<div className="form-error"><AlertTriangle size={15}/>{error}</div>}
      {step!=='password'&&<button type="button" className="secondary" onClick={()=>setStep('password')}>BACK</button>}
    </form>
  </div>;
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('avclpr_token') || '');
  const [user, setUser] = useState<User | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [edge, setEdge] = useState<EdgeStatus | null>(null);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [query, setQuery] = useState('');
  const [siteFilter, setSiteFilter] = useState('ALL');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [route, setRoute] = useState(window.location.pathname || '/');
  useEffect(() => { const onPop = () => setRoute(window.location.pathname || '/'); window.addEventListener('popstate', onPop); return () => window.removeEventListener('popstate', onPop); }, []);
  const navigate = (path: string) => { window.history.pushState({}, '', path); setRoute(path); setSidebarOpen(false); };

  const load = async () => {
    if (!token) return;
    try {
      const [me, eventData, alertData, siteData, edgeData] = await Promise.all([
        api('/auth/me', {}, token), api('/events?limit=100', {}, token), api('/alerts?limit=50&status=active', {}, token), api('/sites', {}, token), api('/system/edge-status', {}, token)
      ]);
      setUser(me.user); setEvents(eventData.events || []); setAlerts(alertData.alerts || []); setSites(siteData.sites || []); setEdge(edgeData); setError(''); setLastRefresh(new Date());
    } catch (e) { setError(e instanceof Error ? e.message : 'Dashboard connection failed'); }
  };
  useEffect(() => { if (token) { sessionStorage.setItem('avclpr_token', token); load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); } }, [token]);
  const logout = async () => { try { await api('/auth/logout', { method: 'POST' }, token); } catch {} sessionStorage.removeItem('avclpr_token'); setToken(''); setUser(null); navigate('/'); };
  const acknowledge = async (id: string) => { try { await api(`/alerts/${id}/acknowledge`, { method: 'POST' }, token); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to acknowledge alert'); } };

  const workers = Object.entries(edge?.camera_workers?.items || {});
  const onlineWorkers = workers.filter(([, w]) => w.connected).length;
  const watchlistEvents = events.filter(e => e.watchlist).length;
  const filteredEvents = useMemo(() => events.filter(e => {
    const q = query.toLowerCase();
    const matchesQ = !q || [e.plate_number, e.vehicle_type, e.site_code, e.site_name, e.camera_code, e.direction].some(v => String(v || '').toLowerCase().includes(q));
    const matchesSite = siteFilter === 'ALL' || (e.site_code || e.site_name) === siteFilter;
    return matchesQ && matchesSite;
  }), [events, query, siteFilter]);
  const vehicleBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    events.forEach(e => { counts[e.vehicle_type] = (counts[e.vehicle_type] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [events]);
  const totalFrames = workers.reduce((n, [, w]) => n + w.frames_processed, 0);
  const totalDrops = workers.reduce((n, [, w]) => n + w.frames_dropped, 0);
  const health = edge?.sync?.central?.connected && edge?.sync?.running ? 'OPERATIONAL' : 'DEGRADED';

  if (!token) return <Login onLogin={(newToken, newUser) => { setToken(newToken); setUser(newUser); navigate('/'); }} />;

  return <div className="dashboard-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-brand"><div className="brand-icon"><Shield size={19}/></div><div><strong>QTS</strong><span>AVCLPR</span></div><button className="mobile-close" onClick={() => setSidebarOpen(false)}><X size={18}/></button></div>
      <div className="nav-label">COMMAND</div>
      <nav>
        <button className={`nav-item ${route === '/' ? 'active' : ''}`} onClick={() => navigate('/')}><LayoutDashboard size={17}/> Overview</button>
        <button className={`nav-item ${route === '/cameras' ? 'active' : ''}`} onClick={() => navigate('/cameras')}><Video size={17}/> Cameras <span>{workers.length}</span></button>
        <button className={`nav-item ${route === '/events' ? 'active' : ''}`} onClick={() => navigate('/events')}><Car size={17}/> Vehicle Events <span>{events.length}</span></button>
        <button className={`nav-item ${route === '/alerts' ? 'active' : ''}`} onClick={() => navigate('/alerts')}><Siren size={17}/> Alerts {alerts.length > 0 && <b>{alerts.length}</b>}</button>
        <button className={`nav-item ${route === '/watchlists' ? 'active' : ''}`} onClick={() => navigate('/watchlists')}><Shield size={17}/> Watchlists</button>
        <button className={`nav-item ${route === '/analytics' ? 'active' : ''}`} onClick={() => navigate('/analytics')}><Gauge size={17}/> Analytics</button>
      </nav>
      <div className="nav-label">SYSTEM</div>
      <nav>
        <button className={`nav-item ${route === '/database' ? 'active' : ''}`} onClick={() => navigate('/database')}><Database size={17}/> Central Database</button>
        {user && ['SUPER_ADMIN','NATIONAL_ADMIN'].includes(user.role) && <button className={`nav-item ${route === '/users' ? 'active' : ''}`} onClick={() => navigate('/users')}><Users size={17}/> Users & Roles</button>}
        {user && ['SUPER_ADMIN','NATIONAL_ADMIN','GICTA'].includes(user.role) && <button className={`nav-item ${route === '/audit' ? 'active' : ''}`} onClick={() => navigate('/audit')}><Activity size={17}/> Audit Logs</button>}
      </nav>
      <div className="sidebar-bottom"><div className="system-mini"><span className="pulse"/><div><strong>System {health.toLowerCase()}</strong><small>Auto-sync {edge?.sync?.running ? 'enabled' : 'stopped'}</small></div></div><button className="logout-side" onClick={logout}><LogOut size={16}/> Sign out</button></div>
    </aside>

    <div className="main-shell">
      <header className="header"><button className="menu-btn" onClick={() => setSidebarOpen(true)}><Menu size={20}/></button><div className="header-title"><span>COMMAND CENTER</span><h1>National Highway Operations</h1></div><div className="header-actions"><div className="global-search"><Search size={16}/><input placeholder="Search plate, site, vehicle…" value={query} onChange={e => setQuery(e.target.value)}/></div><button className="icon-btn" title="Refresh" onClick={load}><RefreshCw size={17}/></button><button className="icon-btn notification"><Bell size={17}/>{alerts.length > 0 && <i/>}</button><div className="profile"><div className="avatar">{(user?.displayName || user?.username || 'U').slice(0, 1).toUpperCase()}</div><div><strong>{user?.displayName || user?.username}</strong><small>{user?.role}</small></div><ChevronDown size={14}/></div></div></header>

      <main className="content">
        {route === '/' && ({error && <div className="error-banner"><AlertTriangle size={16}/><span>{error}</span><button onClick={() => setError('')}><X size={15}/></button></div>}
        <section className="welcome-row"><div><div className="eyebrow">LIVE GOVERNMENT OPERATIONS</div><h2>Highway situation overview</h2><p>Monitoring {sites.length || 0} pilot sites across the national road network.</p></div><div className="live-pill"><span className="pulse"/> LIVE <small>{lastRefresh ? lastRefresh.toLocaleTimeString() : '—'}</small></div></section>

        <section className="kpi-grid">
          <Kpi icon={<Car/>} label="Vehicle Events" value={events.length.toLocaleString()} note="Latest loaded events"/>
          <Kpi icon={<Siren/>} label="Active Alerts" value={alerts.length.toString()} note={alerts.length ? 'Immediate attention' : 'No active threats'} danger={alerts.length > 0}/>
          <Kpi icon={<Shield/>} label="Watchlist Hits" value={watchlistEvents.toString()} note="Current event feed" danger={watchlistEvents > 0}/>
          <Kpi icon={<Radio/>} label="Camera Network" value={`${onlineWorkers}/${workers.length}`} note={workers.length ? 'Connected edge workers' : 'No workers registered'}/>
          <Kpi icon={<Database/>} label="Central Database" value={edge?.sync?.central?.connected ? 'ONLINE' : 'OFFLINE'} note="PostgreSQL connection" good={!!edge?.sync?.central?.connected}/>
        </section>

        <section className="dashboard-grid">
          <div className="card alert-card"><CardHeader icon={<Siren/>} title="Priority alerts" meta={`${alerts.length} active`} accent="red"/>{alerts.length === 0 ? <Empty icon={<CheckCircle2/>} title="No active alerts" text="The network has no unresolved priority alerts."/> : <div className="alert-list">{alerts.slice(0, 5).map(alert => <div className={`alert-row ${alert.severity}`} key={alert.id}><div className="alert-symbol"><AlertTriangle size={17}/></div><div className="alert-copy"><strong>{alert.title}</strong><p>{alert.description || 'Operational alert requires review.'}</p><small>{alert.site_name || alert.site_code || 'Unknown site'} · {new Date(alert.created_at).toLocaleString()}</small></div><div className="alert-actions"><span>{alert.severity}</span>{user && ['SUPER_ADMIN','NATIONAL_ADMIN','POLICE','INTELLIGENCE'].includes(user.role) && <button onClick={() => acknowledge(alert.id)}>ACK</button>}</div></div>)}</div>}</div>

          <div className="card health-card"><CardHeader icon={<Activity/>} title="Infrastructure health" meta={health}/><div className="health-main"><div className={`health-ring ${health === 'OPERATIONAL' ? 'ok' : 'warn'}`}><strong>{health === 'OPERATIONAL' ? '100%' : '!'}</strong><small>HEALTH</small></div><div className="health-items"><HealthItem icon={<Video/>} label="Edge cameras" value={`${onlineWorkers}/${workers.length}`} good={onlineWorkers === workers.length && workers.length > 0}/><HealthItem icon={<Wifi/>} label="Auto synchronization" value={edge?.sync?.running ? 'Running' : 'Stopped'} good={!!edge?.sync?.running}/><HealthItem icon={<Database/>} label="Central PostgreSQL" value={edge?.sync?.central?.connected ? 'Connected' : 'Offline'} good={!!edge?.sync?.central?.connected}/><HealthItem icon={<Activity/>} label="Pending outbox" value={(edge?.sync?.queue?.pending ?? 0).toString()} good={(edge?.sync?.queue?.pending ?? 0) === 0}/></div></div><div className="health-foot"><span>Processed frames <b>{totalFrames.toLocaleString()}</b></span><span>Dropped <b>{totalDrops.toLocaleString()}</b></span><span>Synced <b>{(edge?.sync?.synced_total ?? 0).toLocaleString()}</b></span></div></div>

          <div className="card sites-card"><CardHeader icon={<Radio/>} title="Highway sites" meta={`${sites.length} configured`}/><div className="site-grid">{sites.length === 0 ? <Empty title="No sites configured" text="Pilot locations will appear here."/> : sites.map(site => { const code = site.site_code || site.siteCode || 'SITE'; const siteWorkers = workers.filter(([id]) => id.includes(code)); const online = siteWorkers.some(([, w]) => w.connected); return <div className="site-tile" key={site.id}><div className={`site-status ${online ? 'on' : 'off'}`}><span className="pulse"/></div><div><strong>{code}</strong><span>{site.name}</span><small>{site.road || 'Highway location'} · {online ? 'Online' : (site.status || 'Standby')}</small></div><ChevronDown size={14}/></div>; })}</div></div>

          <div className="card breakdown-card"><CardHeader icon={<Truck/>} title="Traffic composition" meta="Current feed"/><div className="breakdown">{vehicleBreakdown.length ? vehicleBreakdown.map(([type, count]) => <div className="bar-row" key={type}><div><span>{type}</span><b>{count}</b></div><div className="bar"><i style={{ width: `${Math.max(8, (count / Math.max(1, events.length)) * 100)}%` }}/></div></div>) : <Empty title="Awaiting vehicle data" text="Traffic composition will populate as events arrive."/>}</div></div>

          <div className="card events-card"><CardHeader icon={<Activity/>} title="Live vehicle intelligence" meta={`${filteredEvents.length} shown`}/><div className="table-toolbar"><div className="filter-select"><select value={siteFilter} onChange={e => setSiteFilter(e.target.value)}><option value="ALL">All sites</option>{sites.map(s => <option key={s.id} value={s.site_code || s.siteCode || s.name}>{s.site_code || s.siteCode || s.name}</option>)}</select><ChevronDown size={14}/></div><span>Updates every 5 seconds</span></div><div className="table-scroll"><table><thead><tr><th>TIME</th><th>SITE</th><th>VEHICLE</th><th>PLATE</th><th>DIRECTION</th><th>AI CONF.</th><th>STATUS</th></tr></thead><tbody>{filteredEvents.slice(0, 25).map(event => <tr key={event.id}><td className="time">{new Date(event.timestamp).toLocaleTimeString()}</td><td><strong>{event.site_code || event.site_name || '—'}</strong><small>{event.camera_code || event.camera_name || 'Camera'}</small></td><td><span className="vehicle-type"><Car size={14}/>{event.vehicle_type}</span></td><td className="plate">{event.plate_number || 'UNREADABLE'}</td><td>{event.direction || 'UNKNOWN'}</td><td><span className="confidence"><i style={{ width: `${Math.min(100, Math.max(0, (event.detection_confidence || 0) * 100))}%` }}/>{event.detection_confidence != null ? `${(event.detection_confidence * 100).toFixed(0)}%` : '—'}</span></td><td>{event.watchlist ? <span className="status-tag danger">{event.watchlist_category || 'WATCHLIST'}</span> : <span className="status-tag">NORMAL</span>}</td></tr>)}</tbody></table>{filteredEvents.length === 0 && <Empty title="No matching events" text="Try another plate, site or vehicle search."/>}</div></div>
        </section>)}
        {route === '/cameras' && <CamerasPage token={token} sites={sites} onError={setError} />}
        {route === '/events' && <EventsPage events={events} sites={sites} query={query} siteFilter={siteFilter} setSiteFilter={setSiteFilter} />}
        {route === '/alerts' && <AlertsPage token={token} alerts={alerts} refresh={load} />}
        {route === '/watchlists' && <WatchlistsPage token={token} onError={setError} />}
        {route === '/analytics' && <AnalyticsPage events={events} />}
        {route === '/database' && <DatabasePage edge={edge} />}
        {route === '/users' && user && ['SUPER_ADMIN','NATIONAL_ADMIN'].includes(user.role) && <UsersPage token={token} onError={setError} />}
        {route === '/audit' && user && ['SUPER_ADMIN','NATIONAL_ADMIN','GICTA'].includes(user.role) && <AuditPage token={token} />}
      </main>
      <footer><span>QTS · AVCLPR National Vehicle Intelligence Platform</span><span>Session: {user?.role} · Data updates every 5 seconds · Last refresh {lastRefresh?.toLocaleTimeString() || '—'}</span></footer>
    </div>
  </div>;
}


function PageHeader({title,subtitle}:{title:string;subtitle:string}){return <section className="welcome-row"><div><div className="eyebrow">GOVERNMENT OPERATIONS</div><h2>{title}</h2><p>{subtitle}</p></div></section>}
function DataTable({headers,rows}:{headers:string[];rows:any[][]}){return <div className="table-scroll"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j}>{v}</td>)}</tr>)}{!rows.length&&<tr><td colSpan={headers.length}>No records.</td></tr>}</tbody></table></div>}
function CamerasPage({token,sites,onError}:{token:string;sites:Site[];onError:(s:string)=>void}){const [items,setItems]=useState<any[]>([]);const [form,setForm]=useState({siteId:'',cameraCode:'',name:'',host:''});const load=async()=>{try{setItems((await api('/cameras',{},token)).cameras||[])}catch(e){onError(e instanceof Error?e.message:'Unable to load cameras')}};useEffect(()=>{load()},[]);const create=async(e:FormEvent)=>{e.preventDefault();try{await api('/cameras',{method:'POST',body:JSON.stringify({...form,rtspPort:554})},token);setForm({siteId:'',cameraCode:'',name:'',host:''});load()}catch(e){onError(e instanceof Error?e.message:'Unable to create camera')}};return <><PageHeader title="Camera Management" subtitle="Register and maintain authorized highway cameras."/><div className="card"><form className="inline-form" onSubmit={create}><select required value={form.siteId} onChange={e=>setForm({...form,siteId:e.target.value})}><option value="">Site</option>{sites.map(s=><option key={s.id} value={s.id}>{s.site_code}</option>)}</select><input required placeholder="Camera code" value={form.cameraCode} onChange={e=>setForm({...form,cameraCode:e.target.value})}/><input required placeholder="Name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/><input required placeholder="Host/IP" value={form.host} onChange={e=>setForm({...form,host:e.target.value})}/><button className="primary">ADD CAMERA</button></form></div><div className="card"><DataTable headers={['CODE','NAME','SITE','HOST','STATUS']} rows={items.map(c=>[c.camera_code,c.name,sites.find(s=>s.id===c.site_id)?.site_code||c.site_id,c.host,c.status])}/></div></>}
function EventsPage({events,sites,query,siteFilter,setSiteFilter}:any){const filtered=events.filter((e:EventItem)=>{const q=query.toLowerCase();return(!q||[e.plate_number,e.vehicle_type,e.site_code,e.site_name,e.camera_code,e.direction].some(v=>String(v||'').toLowerCase().includes(q)))&&(siteFilter==='ALL'||(e.site_code||e.site_name)===siteFilter)});return <><PageHeader title="Vehicle Events" subtitle="Authorized event stream scoped to your assigned sites."/><div className="card"><div className="table-toolbar"><select value={siteFilter} onChange={e=>setSiteFilter(e.target.value)}><option value="ALL">All sites</option>{sites.map((s:Site)=><option key={s.id} value={s.site_code}>{s.site_code}</option>)}</select><span>{filtered.length} events</span></div><DataTable headers={['TIME','SITE','VEHICLE','PLATE','DIRECTION','CONFIDENCE','STATUS']} rows={filtered.map((e:EventItem)=>[new Date(e.timestamp).toLocaleString(),e.site_code||e.site_name||'—',e.vehicle_type,e.plate_number||'UNREADABLE',e.direction||'UNKNOWN',e.detection_confidence!=null?(e.detection_confidence*100).toFixed(0)+'%':'—',e.watchlist?e.watchlist_category||'WATCHLIST':'NORMAL'])}/></div></>}
function AlertsPage({token,alerts,refresh}:any){return <><PageHeader title="Alerts" subtitle="Watchlist and operational alerts requiring authorized action."/><div className="card"><DataTable headers={['TIME','SEVERITY','TITLE','SITE','STATUS','ACTION']} rows={alerts.map((a:Alert)=>[new Date(a.created_at).toLocaleString(),a.severity,a.title,a.site_name||a.site_code||'—',a.status,<button onClick={async()=>{await api('/alerts/'+a.id+'/acknowledge',{method:'POST'},token);refresh()}}>ACK</button>])}/></div></>}
function WatchlistsPage({token,onError}:{token:string;onError:(s:string)=>void}){const [items,setItems]=useState<any[]>([]);const [form,setForm]=useState({plateNumber:'',category:'GENERAL',description:''});const load=async()=>{try{setItems((await api('/watchlists',{},token)).watchlists||[])}catch(e){onError(e instanceof Error?e.message:'Unable to load watchlists')}};useEffect(()=>{load()},[]);const create=async(e:FormEvent)=>{e.preventDefault();try{await api('/watchlists',{method:'POST',body:JSON.stringify(form)},token);setForm({plateNumber:'',category:'GENERAL',description:''});load()}catch(e){onError(e instanceof Error?e.message:'Unable to create watchlist entry')}};return <><PageHeader title="Watchlists" subtitle="Controlled plate intelligence. All changes are audited."/><div className="card"><form className="inline-form" onSubmit={create}><input required placeholder="Plate number" value={form.plateNumber} onChange={e=>setForm({...form,plateNumber:e.target.value})}/><input required placeholder="Category" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/><input placeholder="Description" value={form.description} onChange={e=>setForm({...form,description:e.target.value})}/><button className="primary">ADD TO WATCHLIST</button></form></div><div className="card"><DataTable headers={['PLATE','CATEGORY','DESCRIPTION','STATUS','ACTION']} rows={items.map(w=>[w.plate_number,w.category,w.description||'—',w.active?'ACTIVE':'INACTIVE',<button onClick={async()=>{await api('/watchlists/'+w.id,{method:'DELETE'},token);load()}}>REMOVE</button>])}/></div></>}
function AnalyticsPage({events}:{events:EventItem[]}){const counts:Record<string,number>={};events.forEach(e=>counts[e.vehicle_type]=(counts[e.vehicle_type]||0)+1);return <><PageHeader title="Analytics" subtitle="Current event-feed analytics."/><div className="kpi-grid"><Kpi icon={<Car/>} label="Events" value={String(events.length)} note="Loaded events"/><Kpi icon={<Shield/>} label="Unique plates" value={String(new Set(events.map(e=>e.plate_number).filter(Boolean)).size)} note="Observed plates"/></div><div className="card">{Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([k,v])=><div className="bar-row" key={k}><div><span>{k}</span><b>{v}</b></div><div className="bar"><i style={{width:Math.max(5,(v/Math.max(1,events.length))*100)+'%'}}/></div></div>)}</div></>}
function DatabasePage({edge}:{edge:any}){return <><PageHeader title="Central Database" subtitle="PostgreSQL and edge synchronization status."/><div className="kpi-grid"><Kpi icon={<Database/>} label="PostgreSQL" value={edge?.sync?.central?.connected?'ONLINE':'OFFLINE'} note="Central connection" good={!!edge?.sync?.central?.connected}/><Kpi icon={<Activity/>} label="Sync" value={edge?.sync?.running?'RUNNING':'STOPPED'} note="Edge synchronization" good={!!edge?.sync?.running}/><Kpi icon={<Radio/>} label="Pending" value={String(edge?.sync?.queue?.pending??0)} note="Outbox events"/></div><div className="card"><pre>{JSON.stringify(edge,null,2)}</pre></div></>}
function UsersPage({token,onError}:{token:string;onError:(s:string)=>void}){const [items,setItems]=useState<any[]>([]);const [form,setForm]=useState({username:'',displayName:'',role:'OPERATOR',password:''});const load=async()=>{try{setItems((await api('/users',{},token)).users||[])}catch(e){onError(e instanceof Error?e.message:'Unable to load users')}};useEffect(()=>{load()},[]);const create=async(e:FormEvent)=>{e.preventDefault();try{await api('/users',{method:'POST',body:JSON.stringify(form)},token);setForm({username:'',displayName:'',role:'OPERATOR',password:''});load()}catch(e){onError(e instanceof Error?e.message:'Unable to create user')}};return <><PageHeader title="Users & Roles" subtitle="Administrative identity and role management."/><div className="card"><form className="inline-form" onSubmit={create}><input required placeholder="Username" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/><input required placeholder="Display name" value={form.displayName} onChange={e=>setForm({...form,displayName:e.target.value})}/><select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>{['NATIONAL_ADMIN','POLICE','TRANSPORT','PURA','GICTA','INTELLIGENCE','ANALYST','OPERATOR','VIEW_ONLY'].map(r=><option key={r}>{r}</option>)}</select><input required minLength={12} type="password" placeholder="Initial password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><button className="primary">CREATE USER</button></form></div><div className="card"><DataTable headers={['USERNAME','NAME','ROLE','MFA','ACTIVE','LAST LOGIN']} rows={items.map(u=>[u.username,u.display_name,u.role_code,u.mfa_enabled?'ENABLED':'REQUIRED',u.active?'YES':'NO',u.last_login_at?new Date(u.last_login_at).toLocaleString():'Never'])}/></div></>}
function AuditPage({token}:{token:string}){const [logs,setLogs]=useState<any[]>([]);useEffect(()=>{api('/audit?limit=200',{},token).then(r=>setLogs(r.logs||[])).catch(()=>{})},[token]);return <><PageHeader title="Audit Logs" subtitle="Server-side security and operational audit trail."/><div className="card"><DataTable headers={['TIME','USER','ACTION','RESOURCE','SITE','IP']} rows={logs.map(l=>[new Date(l.created_at).toLocaleString(),l.username||'SYSTEM',l.action,l.resource_type?l.resource_type+':'+(l.resource_id||''):'—',l.site_id||'—',l.ip_address||'—'])}/></div></>}

function Kpi({ icon, label, value, note, danger, good }: { icon: React.ReactNode; label: string; value: string; note: string; danger?: boolean; good?: boolean }) { return <div className="kpi"><div className={`kpi-icon ${danger ? 'danger' : good ? 'good' : ''}`}>{icon}</div><div><span>{label}</span><strong className={danger ? 'danger-text' : good ? 'good-text' : ''}>{value}</strong><small>{note}</small></div></div>; }
function CardHeader({ icon, title, meta, accent }: { icon: React.ReactNode; title: string; meta: string; accent?: string }) { return <div className="card-header"><div className={`header-icon ${accent || ''}`}>{icon}</div><div><h3>{title}</h3><span>{meta}</span></div><Circle size={8} className="header-dot" fill="currentColor"/></div>; }
function HealthItem({ icon, label, value, good }: { icon: React.ReactNode; label: string; value: string; good: boolean }) { return <div className="health-item"><span className="health-icon">{icon}</span><div><small>{label}</small><strong className={good ? 'good-text' : 'danger-text'}>{value}</strong></div><span className={`health-dot ${good ? 'good' : 'bad'}`}/></div>; }
function Empty({ icon, title, text }: { icon?: React.ReactNode; title: string; text: string }) { return <div className="empty">{icon && <div className="empty-icon">{icon}</div>}<strong>{title}</strong><span>{text}</span></div>; }

export default App;
