import { db } from './server-db.js';

export function bootstrapIsAvailable(): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM avclpr_users`).get() as any;
  return Number(row?.count ?? 0) === 0;
}
