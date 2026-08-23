-- Cleanup SQL for test users
-- Remove any users with test-related emails or usernames.
DELETE FROM users
WHERE email ILIKE '%test%'
   OR username ILIKE '%test%';
