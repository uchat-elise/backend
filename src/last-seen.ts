export const LAST_SEEN_COOLDOWN_MS = 10000;

export interface LastSeenUserLike {
  id?: string;
  last_seen?: string | null;
  hide_last_seen?: boolean | null;
}

export function shouldRefreshLastSeen(lastSeen: string | Date | null | undefined, now = new Date()): boolean {
  if (!lastSeen) return true;
  const parsed = lastSeen instanceof Date ? lastSeen : new Date(lastSeen);
  if (Number.isNaN(parsed.getTime())) return true;
  return now.getTime() - parsed.getTime() >= LAST_SEEN_COOLDOWN_MS;
}

export function getVisibleLastSeen(
  currentUser?: LastSeenUserLike | null,
  otherUser?: LastSeenUserLike | null,
): string | null {
  if (!otherUser) return null;
  if (Boolean(currentUser?.hide_last_seen) || Boolean(otherUser.hide_last_seen)) {
    return null;
  }
  return otherUser.last_seen ?? null;
}
