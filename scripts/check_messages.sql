-- Run this in your Supabase SQL editor or psql connected to the project
-- Shows the most recent 10 messages
SELECT * FROM messages ORDER BY created_at DESC LIMIT 10;