import 'dotenv/config';
import { seedSuperAdmin } from '../src/lib/auth-db.js';

try {
  const result = seedSuperAdmin();

  if (result.created) {
    console.log(`Super Admin created successfully: ${result.user.username}`);
    console.log(`Role: ${result.user.role}`);
  } else {
    console.log(`Super Admin already exists: ${result.user.username}`);
    console.log('No changes were made.');
  }
} catch (error: any) {
  console.error(`Super Admin seed failed: ${error?.message || error}`);
  process.exitCode = 1;
}
