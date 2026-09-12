import './production-foundation.js';
import { db } from './server-db.js';

const policy: Record<string, string[]> = {
  SUPER_ADMIN: ['*'],
  NATIONAL_ADMIN: [
    'dashboard.read','sites.read','sites.write','cameras.read','cameras.write',
    'events.read','events.export','evidence.read','evidence.export',
    'watchlists.read','watchlists.write','alerts.read','alerts.manage',
    'reports.read','reports.export','users.read','users.write','audit.read','system.manage',
  ],
  POLICE: [
    'dashboard.read','sites.read','cameras.read','events.read','events.export',
    'evidence.read','evidence.export','watchlists.read','watchlists.write',
    'alerts.read','alerts.manage','reports.read','reports.export',
  ],
  TRANSPORT: [
    'dashboard.read','sites.read','cameras.read','events.read','reports.read','reports.export','alerts.read',
  ],
  PURA: [
    'dashboard.read','sites.read','cameras.read','events.read','reports.read','reports.export','alerts.read',
  ],
  GICTA: [
    'dashboard.read','sites.read','sites.write','cameras.read','cameras.write','alerts.read','alerts.manage','audit.read','system.manage',
  ],
  INTELLIGENCE: [
    'dashboard.read','sites.read','cameras.read','events.read','events.export','evidence.read','evidence.export',
    'watchlists.read','watchlists.write','alerts.read','alerts.manage','reports.read','reports.export','audit.read',
  ],
  ANALYST: [
    'dashboard.read','sites.read','cameras.read','events.read','events.export','reports.read','reports.export','alerts.read',
  ],
  OPERATOR: [
    'dashboard.read','sites.read','cameras.read','events.read','alerts.read','alerts.manage',
  ],
  VIEW_ONLY: [
    'dashboard.read','sites.read','cameras.read','events.read','alerts.read','reports.read',
  ],
};

for (const [role, permissions] of Object.entries(policy)) {
  for (const permission of permissions) {
    if (permission === '*') continue;
    db.prepare(`INSERT OR IGNORE INTO avclpr_role_permissions(role_code,permission_code) VALUES(?,?)`).run(role, permission);
  }
}

export { policy };
