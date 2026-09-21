import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, initializeProductionFoundation } from '../src/lib/production-foundation.js';

try {
  await initializeProductionFoundation();
  const username=(process.env.SEED_ADMIN_USERNAME||'superadmin').trim();
  const displayName=(process.env.SEED_ADMIN_NAME||'QTS System Super Administrator').trim();
  const password=process.env.SEED_ADMIN_PASSWORD||'';
  if(!password)throw new Error('SEED_ADMIN_PASSWORD is required.');
  if(password.length<12)throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  const role=await pool.query('SELECT id FROM roles WHERE code=\'SUPER_ADMIN\'');
  const existing=await pool.query('SELECT id FROM users WHERE username=$1 LIMIT 1',[username]);
  if(existing.rows[0]){console.log(`Super Admin already exists: ${username}`);process.exit(0);}
  const hash=await bcrypt.hash(password,12);
  await pool.query('INSERT INTO users(username,display_name,password_hash,role_id,active) VALUES($1,$2,$3,$4,true)',[username,displayName,hash,role.rows[0].id]);
  console.log(`Super Admin created successfully: ${username}`);
} catch(error:any) {
  console.error(`Super Admin seed failed: ${error?.message||error}`);
  process.exitCode=1;
} finally { await pool.end(); }
