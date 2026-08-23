import crypto from 'crypto';

const users = [
  { id: crypto.randomUUID(), email: 'admin@example.com', username: 'admin', displayName: 'Admin User', password: 'password123', role: 'admin' },
  { id: crypto.randomUUID(), email: 'user1@example.com', username: 'user1', displayName: 'Test User 1', password: 'password123', role: 'user' },
  { id: crypto.randomUUID(), email: 'user2@example.com', username: 'user2', displayName: 'Test User 2', password: 'password123', role: 'user' },
  { id: crypto.randomUUID(), email: 'user3@example.com', username: 'user3', displayName: 'Test User 3', password: 'password123', role: 'user' },
  { id: crypto.randomUUID(), email: 'user4@example.com', username: 'user4', displayName: 'Test User 4', password: 'password123', role: 'user' },
  { id: crypto.randomUUID(), email: 'user5@example.com', username: 'user5', displayName: 'Test User 5', password: 'password123', role: 'user' },
];

const rooms = [
  { id: crypto.randomUUID(), name: 'Welcome Hub', description: 'Public room for everyone', privacy: 'public' },
  { id: crypto.randomUUID(), name: 'Design Talks', description: 'Public room for design conversations', privacy: 'public' },
  { id: crypto.randomUUID(), name: 'Dev Circle', description: 'Public room for engineering chatter', privacy: 'public' },
  { id: crypto.randomUUID(), name: 'Private Team', description: 'Private room for testing', privacy: 'private' },
];

console.log('Seed script ready.');
console.log(JSON.stringify({ users, rooms }, null, 2));
