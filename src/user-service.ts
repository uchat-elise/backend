import { type SupabaseClient } from '@supabase/supabase-js';

export class UserNotFoundError extends Error {
  code: 'USER_NOT_FOUND';

  constructor(username: string) {
    super(`User not found: ${username}`);
    this.name = 'UserNotFoundError';
    this.code = 'USER_NOT_FOUND';
  }
}

export async function resolveUserId(
  supabase: SupabaseClient,
  username: string,
): Promise<string> {
  const normalizedUsername = username.trim();
  if (!normalizedUsername) throw new UserNotFoundError(username);

  const { data, error } = await supabase
    .from('users')
    .select('id')
    .ilike('username', normalizedUsername)
    .maybeSingle();

  if (error) throw new Error(`Unable to resolve user ${normalizedUsername}: ${error.message}`);
  if (!data?.id) throw new UserNotFoundError(normalizedUsername);
  return data.id;
}