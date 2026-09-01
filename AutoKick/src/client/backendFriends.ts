import type { BackendEvent } from "../backend/protocol";
import type { BackendSocket } from "./backendSocket";

export interface FriendCandidate {
  xuid: string;
  gamertag: string;
  avatarUrl?: string;
}
export interface FriendRequestSender {
  accountId: string;
  gamertag: string;
  updatedAt: string;
}
export interface FriendRequestQueueItem {
  xuid: string;
  gamertag: string;
  sent: FriendRequestSender[];
  pending: FriendRequestSender[];
}
export async function searchFriends(
  socket: BackendSocket,
  accountId: string,
  query: string,
): Promise<FriendCandidate[]> {
  const requestId = crypto.randomUUID();
  const response = await socket.request<
    Extract<BackendEvent, { type: "friend-results" }>
  >({ type: "search-friends", requestId, accountId, query }, requestId);
  return response.people as FriendCandidate[];
}
export async function addFriend(
  socket: BackendSocket,
  accountId: string,
  xuid: string,
): Promise<void> {
  const requestId = crypto.randomUUID();
  await socket.request(
    { type: "add-friend", requestId, accountId, xuid },
    requestId,
  );
}
export async function listFriendRequestQueue(socket: BackendSocket, accountId?: string): Promise<FriendRequestQueueItem[]> {
  const requestId = crypto.randomUUID();
  const response = await socket.request<Extract<BackendEvent, { type: "friend-request-queue" }>>({ type: "list-friend-request-queue", requestId, accountId }, requestId);
  return response.requests as FriendRequestQueueItem[];
}
