import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/server-db.js';
import '../src/lib/production-foundation.js';

try {
  const username = (process.env.SEED_ADMIN_USERNAME || 'superadmin').trim();
  const displayName = (process.env.SEED_ADMIN_NAME || 'QTS System Super Administrator').trim();
  const password = process.env.SEED_ADMIN_PASSWORD || '';

  if (!password) throw new Error('SEED_ADMIN_PASSWORD is required. Set it in .env before running the seed.');
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters long.');
  if (!username || username.length < 3) throw new Error('SEED_ADMIN_USERNAME must contain at least 3 characters.');
  if (!displayName) throw new Error('SEED_ADMIN_NAME must not be empty.');

  const existing = db.prepare(`SELECT id, username, display_name, role_code, active FROM avclpr_users WHERE username=? LIMIT 1`).get(username) as any;

  if (existing) {
    console.log(`Super Admin already exists: ${existing.username}`);
    console.log(`Role: ${existing.role_code}`);
    console.log('No changes were made.');
    process.exit(0);
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const passwordHash = bcrypt.hashSync(password, 12);

  db.prepare(`
    INSERT INTO avclpr_users(
      id, username, display_name, password_hash, role_code,
      active, failed_login_count, locked_until, last_login_at,
      created_at, updated_at
    ) VALUES(?,?,?,?,?,1,0,NULL,NULL,?,?)
  `).run(id, username, displayName, passwordHash, 'SUPER_ADMIN', now, now);

  console.log(`Super Admin created successfully: ${username}`);
  console.log('Role: SUPER_ADMIN');
  console.log('Password stored as a bcrypt hash; the plaintext password was not stored.');
} catch (error: any) {
  console.error(`Super Admin seed failed: ${error?.message || error}`);
  process.exitCode = 1;
}
