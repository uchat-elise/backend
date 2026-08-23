import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function run() {
  const identifier = 'elise';
  const password = 'Niyibeshaho1';
  console.log('Logging in as', identifier);

  const res = await fetch('http://localhost:3001/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const body = await res.text();
  console.log('status', res.status);
  console.log('body', body);

  if (res.ok) {
    const json = JSON.parse(body);
    const token = json.token;
    console.log('token', token?.slice(0, 20) + '...');
    const searchRes = await fetch(`http://localhost:3001/api/users/search?q=elise3`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    const searchBody = await searchRes.text();
    console.log('search status', searchRes.status);
    console.log('search body', searchBody);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
