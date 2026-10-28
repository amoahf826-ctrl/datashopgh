import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const envPath = resolve(process.cwd(), '.env.admin.local');
let envText;

try {
  envText = readFileSync(envPath, 'utf8');
} catch {
  console.error('Missing .env.admin.local. Create it in the project root with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const config = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, '$2')];
    }),
);

const userId = process.argv[2];
const secretKey = config.SUPABASE_SECRET_KEY || config.SUPABASE_SERVICE_ROLE_KEY;
if (!config.SUPABASE_URL || !secretKey || !userId) {
  console.error('Usage: npm run confirm-account -- <AUTH_USER_ID>');
  console.error('The local .env.admin.local file must define SUPABASE_URL and SUPABASE_SECRET_KEY.');
  process.exit(1);
}

const supabase = createClient(config.SUPABASE_URL, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { error } = await supabase.auth.admin.updateUserById(userId, { email_confirm: true });
if (error) {
  console.error(`Could not confirm account: ${error.message}`);
  process.exit(1);
}

console.log('Email confirmed for the specified account. You can now sign in to DataShopGH.');
