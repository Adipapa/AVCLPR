import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const DATABASE_PATH = path.join(DATA_DIR, 'avclpr1.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const authDb = new DatabaseSync(DATABASE_PATH);

authDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_username
  ON users(username);
`);

export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToAuthUser(row: any): AuthUser {
  return {
    id: String(row.id),
    username: String(row.username),
    name: String(row.name),
    role: String(row.role),
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getUserByUsername(username: string): AuthUser | null {
  const row = authDb
    .prepare(`SELECT * FROM users WHERE username = ? LIMIT 1`)
    .get(username.trim()) as any;

  return row ? rowToAuthUser(row) : null;
}

export function verifyUserPassword(
  username: string,
  password: string
): AuthUser | null {
  const row = authDb
    .prepare(`SELECT * FROM users WHERE username = ? LIMIT 1`)
    .get(username.trim()) as any;

  if (!row || !row.is_active) {
    return null;
  }

  const valid = bcrypt.compareSync(password, String(row.password_hash));

  return valid ? rowToAuthUser(row) : null;
}

export function seedSuperAdmin(): {
  created: boolean;
  user: AuthUser;
} {
  const username = (process.env.SEED_ADMIN_USERNAME || 'superadmin').trim();
  const name = (process.env.SEED_ADMIN_NAME || 'QTS System Super Administrator').trim();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required. Set it in .env before running the seed.'
    );
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters long.');
  }

  if (!username || username.length < 3) {
    throw new Error('SEED_ADMIN_USERNAME must contain at least 3 characters.');
  }

  const existing = authDb
    .prepare(`SELECT * FROM users WHERE username = ? LIMIT 1`)
    .get(username) as any;

  if (existing) {
    return {
      created: false,
      user: rowToAuthUser(existing),
    };
  }

  const now = new Date().toISOString();
  const id = `user_${crypto.randomUUID()}`;
  const passwordHash = bcrypt.hashSync(password, 12);

  authDb
    .prepare(`
      INSERT INTO users (
        id,
        username,
        password_hash,
        name,
        role,
        is_active,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `)
    .run(
      id,
      username,
      passwordHash,
      name,
      'superadmin',
      now,
      now
    );

  const created = authDb
    .prepare(`SELECT * FROM users WHERE id = ? LIMIT 1`)
    .get(id) as any;

  if (!created) {
    throw new Error('Super Admin was not created successfully.');
  }

  return {
    created: true,
    user: rowToAuthUser(created),
  };
}
