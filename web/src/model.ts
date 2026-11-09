export type Device = { id: string; name: string; platform: string };
export type LinkState =
  | "idle"
  | "outgoing"
  | "incoming"
  | "connecting"
  | "connected"
  | "failed"
  | "rejected"
  | "expired"
  | "offline";
export type SharedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
};
export type Message = {
  kind: "message";
  id: string;
  peerId: string;
  mine: boolean;
  text: string;
  time: number;
  status: "sending" | "delivered" | "failed";
};
export type Transfer = {
  kind: "file";
  id: string;
  peerId: string;
  mine: boolean;
  name: string;
  size: number;
  type: string;
  time: number;
  bytes: number;
  speed: number;
  status:
    | "queued"
    | "offered"
    | "transferring"
    | "complete"
    | "cancelled"
    | "failed";
  error?: string;
  url?: string;
};
export type ChatItem = Message | Transfer;
export type Peer = Device & {
  state: LinkState;
  online: boolean;
  items: ChatItem[];
  shared: SharedFile[];
  unread: number;
  error?: string;
  route?: string;
};
export type AppState = {
  cloud: "connecting" | "connected" | "disconnected";
  self?: Device;
  roomId?: string;
  peers: Record<string, Peer>;
  selected?: string;
  shared: SharedFile[];
  notice?: string;
  invite?: string;
  inviteExpires?: string;
  supported: boolean;
  ipv6: boolean;
};
export const MAX_FILE = 256 * 1024 * 1024;
export const uid = () => crypto.randomUUID();
export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** i).toFixed(i > 0 ? 1 : 0)} ${["B", "KB", "MB", "GB"][i]}`;
}
