-- PostgreSQL notification channels are limited to 63 bytes.
-- Chat IDs contain two UUIDs and exceed that limit, so keep chat_id in the payload
-- and use one fixed short channel for message notifications.

CREATE OR REPLACE FUNCTION public.broadcast_message_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'private_messages',
    json_build_object(
      'type', 'INSERT',
      'id', NEW.id,
      'chat_id', NEW.chat_id,
      'sender_username', NEW.sender_username,
      'sender_display_name', NEW.sender_display_name,
      'content', NEW.content,
      'created_at', NEW.created_at,
      'attachments', NEW.attachments,
      'voice_note', NEW.voice_note
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.broadcast_message_edit()
RETURNS trigger AS $$
BEGIN
  IF OLD.content IS DISTINCT FROM NEW.content OR OLD.edited IS DISTINCT FROM NEW.edited THEN
    PERFORM pg_notify(
      'private_messages',
      json_build_object(
        'type', 'UPDATE',
        'id', NEW.id,
        'chat_id', NEW.chat_id,
        'content', NEW.content,
        'edited', NEW.edited,
        'updated_at', NEW.updated_at
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.broadcast_message_delete()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'private_messages',
    json_build_object(
      'type', 'DELETE',
      'id', OLD.id,
      'chat_id', OLD.chat_id
    )::text
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
