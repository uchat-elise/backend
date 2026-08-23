import dotenv from 'dotenv';
dotenv.config();

const base = 'http://127.0.0.1:3001';
const username = `testsearchuser${Date.now()}`;
const email = `testsearch+${Date.now()}@example.com`;
const password = 'Password123!';

async function run() {
  const registerRes = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, displayName: 'Test Search User', password, confirmPassword: password }),
  });
  const registerJson = await registerRes.json();
  console.log('register status', registerRes.status);
  console.log('register body', JSON.stringify(registerJson, null, 2));

  if (!registerJson.verificationLink) {
    console.error('Registration did not return a verification link.');
    process.exit(1);
  }

  const token = new URL(registerJson.verificationLink).searchParams.get('token');
  if (!token) {
    console.error('No verification token found in link.');
    process.exit(1);
  }

  const verifyRes = await fetch(`${base}/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  const verifyJson = await verifyRes.json();
  console.log('verify status', verifyRes.status);
  console.log('verify body', JSON.stringify(verifyJson, null, 2));

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: username, password }),
  });
  const loginJson = await loginRes.json();
  console.log('login status', loginRes.status);
  console.log('login body', JSON.stringify(loginJson, null, 2));
  if (!loginJson.token) {
    console.error('Login failed, cannot test search endpoint.');
    process.exit(1);
  }

  const searchRes = await fetch(`${base}/api/users/search?q=elise3`, {
    headers: { Authorization: `Bearer ${loginJson.token}` },
  });
  const searchJson = await searchRes.json();
  console.log('search status', searchRes.status);
  console.log('search body', JSON.stringify(searchJson, null, 2));
}

run().catch((err) => {
  console.error('Error', err);
  process.exit(1);
});
