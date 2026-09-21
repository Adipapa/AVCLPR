import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../src/lib/production-foundation.js';

const files=['001_initial_schema.sql','002_security_and_sessions.sql','003_evidence_governance.sql'];
try{
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(version VARCHAR(128) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  for(const file of files){
    const version=file;
    const done=await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version]);
    if(done.rowCount) { console.log(`Skipping ${version}`); continue; }
    const sql=await fs.readFile(path.resolve('database/postgresql',file),'utf8');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]);
      await client.query('COMMIT');
      console.log(`Applied ${version}`);
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
}catch(error){console.error('[MIGRATION FAILED]',error);process.exitCode=1;}finally{await pool.end();}
