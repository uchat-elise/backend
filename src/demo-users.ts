import crypto from 'crypto';

export interface DemoUserRecord {
  id: string;
  email: string;
  username: string;
  display_name: string;
  profile_picture: string | null;
  created_at: string;
  password_hash: string;
  email_verified: boolean;
  last_seen: string | null;
  hide_last_seen: boolean;
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

export function ensureDemoUsersExist(target: DemoUserRecord[] = []) {
  const demoUsers: DemoUserRecord[] = [
    {
      id: 'demo-user-a',
      email: 'userA@example.com',
      username: 'userA',
      display_name: 'User A',
      profile_picture: null,
      created_at: new Date().toISOString(),
      password_hash: hashPassword('Niyibeshaho1'),
      email_verified: true,
      last_seen: null,
      hide_last_seen: false,
    },
    {
      id: 'demo-user-elise3',
      email: 'elise3@example.com',
      username: 'elise3',
      display_name: 'Elise',
      profile_picture: null,
      created_at: new Date().toISOString(),
      password_hash: hashPassword('Niyibeshaho1'),
      email_verified: true,
      last_seen: null,
      hide_last_seen: false,
    },
  ];

  for (const user of demoUsers) {
    const existingIndex = target.findIndex((existing) =>
      existing.username.toLowerCase() === user.username.toLowerCase() ||
      existing.email.toLowerCase() === user.email.toLowerCase(),
    );

    if (existingIndex === -1) {
      target.push(user);
      continue;
    }

    const existing = target[existingIndex];
    target[existingIndex] = {
      ...existing,
      ...user,
      id: existing.id || user.id,
      username: user.username,
      email: user.email,
      display_name: user.display_name,
      profile_picture: user.profile_picture,
      created_at: existing.created_at || user.created_at,
      password_hash: user.password_hash,
      email_verified: true,
      last_seen: existing.last_seen ?? user.last_seen,
      hide_last_seen: Boolean(user.hide_last_seen),
    };
  }

  return target;
}
