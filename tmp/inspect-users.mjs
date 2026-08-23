import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function run() {
  const { data, error } = await supabase.from('users').select('*').limit(1).maybeSingle();
  console.log('error:', error);
  console.log('data:', data);
  if (data) {
    console.log('columns:', Object.keys(data).sort());
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
