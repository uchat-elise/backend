export const getFriendRelationship = ({ currentUserId, targetUserId, pendingRequests = [], friendsByUserId = new Map() }) => {
  if (currentUserId === targetUserId) return 'self';

  const pendingRequest = pendingRequests.find((request) => {
    const senderMatches = request.senderId === currentUserId && request.receiverId === targetUserId;
    const receiverMatches = request.senderId === targetUserId && request.receiverId === currentUserId;
    return senderMatches || receiverMatches;
  });

  if (pendingRequest) return 'pending';

  const directFriends = friendsByUserId.get(targetUserId) ?? new Set();
  if (directFriends.has(currentUserId)) return 'friend';

  return 'none';
};

export const resolveTargetUser = ({ targetUserId, targetUsername, users = [] }) => {
  if (targetUserId) {
    const byId = users.find((user) => user.id === targetUserId);
    if (byId) return byId;
  }

  const normalizedUsername = String(targetUsername ?? '').trim().toLowerCase();
  if (!normalizedUsername) return null;

  return users.find((user) => user.username && user.username.toLowerCase() === normalizedUsername) ?? null;
};
