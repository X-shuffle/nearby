import {
  MAX_FILE,
  uid,
  type AppState,
  type Device,
  type Peer,
  type SharedFile,
  type Transfer,
} from "./model";

type Wire = { type: string; payload?: any };
type Outgoing = {
  view: Transfer;
  file: File;
  timer?: ReturnType<typeof setTimeout>;
  sending: boolean;
};
type Incoming = {
  view: Transfer;
  chunks: ArrayBuffer[];
  timer?: ReturnType<typeof setTimeout>;
  reserved: boolean;
};
type Link = {
  pc: RTCPeerConnection;
  control?: RTCDataChannel;
  bulk?: RTCDataChannel;
  candidates: RTCIceCandidateInit[];
  chain: Promise<void>;
  queue: Outgoing[];
  sending?: Outgoing;
  incoming?: Incoming;
  inboundWireId?: string;
  requested: Map<string, ReturnType<typeof setTimeout>>;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  negotiating: boolean;
};
const TIMEOUT = 60_000;
const CHUNK = 16 * 1024;
const cleanName = (name: string) =>
  name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 240) || "未命名文件";
function deviceName() {
  const stored = localStorage.getItem("nearby.name");
  if (stored) return stored;
  const platform = platformName();
  return `我的${platform.includes("iPhone") || platform.includes("Android") ? "手机" : "电脑"}`;
}
function platformName() {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua)
    ? "iPhone / iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac/.test(ua)
          ? "macOS"
          : "浏览器";
}

export class NearbyClient {
  private state: AppState = {
    cloud: "connecting",
    peers: {},
    shared: [],
    supported: typeof RTCPeerConnection !== "undefined" && !!crypto.randomUUID,
    ipv6: false,
  };
  private listeners = new Set<() => void>();
  private ws?: WebSocket;
  private links = new Map<string, Link>();
  private localFiles = new Map<string, File>();
  private inviteToken?: string;
  private reconnect?: ReturnType<typeof setTimeout>;
  private retry = 0;
  private disposed = false;
  private stun: RTCIceServer[] = [];
  private retained = 0;
  private downloads = new Map<string, number>();
  private messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private captureInvite = () => {
    const token = new URLSearchParams(location.hash.slice(1)).get("invite");
    if (!token) return;
    history.replaceState(null, "", location.pathname + location.search);
    if (!/^[a-f0-9]{64}$/.test(token)) {
      this.notice("邀请链接格式无效");
      return;
    }
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      this.state.cloud === "connected"
    )
      this.command("invite.join", undefined, { token });
    else this.inviteToken = token;
  };
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private update() {
    this.state = {
      ...this.state,
      peers: { ...this.state.peers },
      shared: [...this.state.shared],
    };
    this.listeners.forEach((fn) => fn());
  }
  notice(message?: string) {
    this.state.notice = message;
    this.update();
  }
  select(id?: string) {
    this.state.selected = id;
    if (id && this.state.peers[id]) this.state.peers[id].unread = 0;
    this.update();
  }
  async start() {
    this.disposed = false;
    this.captureInvite();
    window.addEventListener("hashchange", this.captureInvite);
    await this.connect();
  }
  private async connect() {
    if (this.disposed) return;
    try {
      const response = await fetch("/api/config");
      if (!response.ok) throw new Error("无法读取服务配置");
      const config = await response.json();
      if (this.disposed) return;
      // Only STUN is accepted. No TURN or implicit relay fallback can be configured.
      this.stun = (config.stunUrls || [])
        .filter(
          (v: unknown) => typeof v === "string" && /^stuns?:/.test(v as string),
        )
        .map((urls: string) => ({ urls }));
      const url = new URL(config.discoveryUrl || "/api/ws", location.href);
      if (url.protocol === "https:") url.protocol = "wss:";
      if (url.protocol === "http:") url.protocol = "ws:";
      url.searchParams.set("name", deviceName());
      url.searchParams.set("platform", platformName());
      this.ws = new WebSocket(url);
      this.ws.onmessage = (event) => {
        try {
          this.handle(JSON.parse(event.data));
        } catch {
          this.notice("收到无效服务消息，请刷新重试");
        }
      };
      this.ws.onclose = () => this.cloudLost();
      this.ws.onerror = () => {
        this.state.cloud = "disconnected";
        this.update();
      };
    } catch (error) {
      this.state.notice = `云端连接失败：${(error as Error).message}`;
      this.cloudLost();
    }
  }
  private cloudLost() {
    if (this.disposed) return;
    this.state.cloud = "disconnected";
    // Existing P2P channels survive loss of signaling. Do not mark working transfers failed.
    for (const peer of Object.values(this.state.peers)) {
      if (peer.state !== "connected") {
        this.closeLink(peer.id, "云端连接已断开");
        peer.online = false;
        if (peer.state !== "offline") peer.state = "failed";
      }
    }
    this.update();
    clearTimeout(this.reconnect);
    this.reconnect = setTimeout(
      () => {
        void this.connect();
      },
      Math.min(15_000, 1000 * 2 ** this.retry++),
    );
  }
  private command(type: string, peerId?: string, payload?: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN)
      throw new Error("云端未连接，请稍后重试");
    this.ws.send(JSON.stringify({ type, peerId, payload }));
  }
  private addPeer(d: Device) {
    const old = this.state.peers[d.id];
    this.state.peers[d.id] = old
      ? {
          ...old,
          ...d,
          online: true,
          ...(!old.online || old.state === "offline"
            ? { state: "idle" as const, error: undefined, route: undefined }
            : {}),
        }
      : { ...d, state: "idle", online: true, items: [], shared: [], unread: 0 };
  }
  private retirePeer(id: string, reason: string) {
    const peer = this.state.peers[id];
    if (!peer) return;
    this.closeLink(id, reason);
    if (peer.items.length === 0) {
      delete this.state.peers[id];
      if (this.state.selected === id) this.state.selected = undefined;
      return;
    }
    peer.online = false;
    peer.state = "offline";
    peer.shared = [];
  }
  private handle(event: Wire) {
    const p = event.payload;
    switch (event.type) {
      case "welcome":
        // A fresh signaling identity requires fresh pairing; old remote peers get peer.left.
        if (this.state.self && this.state.self.id !== p.self.id)
          for (const peer of Object.values(this.state.peers)) {
            this.retirePeer(peer.id, "云端会话已更新，请重新连接");
          }
        this.state.self = p.self;
        this.state.roomId = p.roomId;
        this.state.ipv6 = !!p.ipv6;
        this.state.cloud = "connected";
        this.retry = 0;
        p.peers.forEach((peer: Device) => this.addPeer(peer));
        if (this.inviteToken) {
          this.command("invite.join", undefined, { token: this.inviteToken });
          this.inviteToken = undefined;
        }
        break;
      case "peer.joined":
      case "peer.updated":
        this.addPeer(p);
        break;
      case "self.updated":
        this.state.self = p;
        localStorage.setItem("nearby.name", p.name);
        break;
      case "peer.left": {
        this.retirePeer(p.id, "对方已离线，传输已中断");
        break;
      }
      case "pair.state": {
        const peer = this.state.peers[p.peerId];
        if (!peer) break;
        if (p.status === "pending") {
          peer.state =
            p.initiator === this.state.self?.id ? "outgoing" : "incoming";
          peer.error = undefined;
        } else if (p.status === "accepted") {
          peer.state = "connecting";
          this.newLink(peer, p.initiator === this.state.self?.id);
        } else {
          this.closeLink(
            peer.id,
            p.status === "rejected"
              ? "对方拒绝了连接"
              : p.status === "expired"
                ? "连接请求已过期"
                : "连接已断开",
          );
          if (peer.state !== "failed")
            peer.state =
              p.status === "rejected"
                ? "rejected"
                : p.status === "expired"
                  ? "expired"
                  : "idle";
        }
        break;
      }
      case "signal": {
        const link = this.links.get(p.peerId);
        if (!link) break;
        link.chain = link.chain
          .then(async () => {
            if (link.closed) return;
            if (p.kind === "description") {
              await link.pc.setRemoteDescription(p.data);
              for (const candidate of link.candidates.splice(0))
                await link.pc.addIceCandidate(candidate);
              if (p.data.type === "offer") {
                await link.pc.setLocalDescription(await link.pc.createAnswer());
                this.signal(p.peerId, "description", link.pc.localDescription);
              }
            } else if (p.kind === "candidate" && p.data) {
              if (link.pc.remoteDescription)
                await link.pc.addIceCandidate(p.data);
              else link.candidates.push(p.data);
            }
          })
          .catch(() =>
            this.fail(p.peerId, "直连协商失败，请重试；本服务未启用中继"),
          );
        break;
      }
      case "invite.created":
        this.state.invite = `${location.origin}${location.pathname}#invite=${p.token}`;
        this.state.inviteExpires = p.expiresAt;
        break;
      case "invite.joined":
        this.state.selected = p.peerId;
        this.state.notice = "邀请已验证，选择请求连接后等待对方确认";
        break;
      case "error":
        this.state.notice = p.message;
        if (p.command === "pair.request") {
          const peer = this.state.peers[p.peerId];
          if (peer && peer.state === "outgoing") peer.state = "idle";
        }
        break;
    }
    this.update();
  }
  request(id: string) {
    try {
      if (!this.state.supported)
        throw new Error(
          "当前浏览器不支持 WebRTC，请使用新版 Chrome、Edge、Safari 或 Firefox",
        );
      const peer = this.state.peers[id];
      this.closeLink(id, "正在重新连接");
      this.command("pair.request", id);
      if (peer) {
        peer.state = "outgoing";
        peer.error = undefined;
      }
      this.select(id);
    } catch (e) {
      this.notice((e as Error).message);
    }
  }
  respond(id: string, accept: boolean) {
    try {
      if (accept && !this.state.supported)
        throw new Error("当前浏览器不支持 WebRTC，请使用新版浏览器");
      this.command("pair.respond", id, { accept });
      if (accept) this.select(id);
    } catch (e) {
      this.notice((e as Error).message);
    }
  }
  disconnect(id: string) {
    this.closeLink(id, "连接已断开");
    const peer = this.state.peers[id];
    if (peer) peer.state = "idle";
    try {
      this.command("pair.disconnect", id);
    } catch {
      /* Local disconnect remains effective offline. */
    }
    this.update();
  }
  rename(name: string) {
    try {
      this.command("device.rename", undefined, { name });
    } catch (e) {
      this.notice((e as Error).message);
    }
  }
  invite() {
    try {
      this.command("invite.create");
    } catch (e) {
      this.notice((e as Error).message);
    }
  }
  retryCloud() {
    clearTimeout(this.reconnect);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.state.cloud = "connecting";
    this.retry = 0;
    this.update();
    void this.connect();
  }
  private signal(id: string, kind: string, data: unknown) {
    this.command("signal", id, { kind, data });
  }
  private newLink(peer: Peer, initiator: boolean) {
    this.closeLink(peer.id, "正在建立新连接");
    const pc = new RTCPeerConnection({ iceServers: this.stun });
    const link: Link = {
      pc,
      candidates: [],
      chain: Promise.resolve(),
      queue: [],
      requested: new Map(),
      closed: false,
      negotiating: false,
    };
    this.links.set(peer.id, link);
    link.handshakeTimer = setTimeout(
      () =>
        this.fail(
          peer.id,
          "直连超时。请检查 VPN、防火墙或 Wi-Fi 设备隔离后重试；未启用中继。",
        ),
      20_000,
    );
    pc.onicecandidate = (event) => {
      if (event.candidate && !link.closed) {
        try {
          this.signal(peer.id, "candidate", event.candidate.toJSON());
        } catch {
          this.fail(peer.id, "信令连接中断，请重新连接");
        }
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed")
        this.fail(
          peer.id,
          "直连失败。请检查 VPN、防火墙或 Wi-Fi 设备隔离；未启用中继。",
        );
      if (pc.connectionState === "disconnected") {
        peer.error = "网络暂时中断，正在等待恢复…";
        this.update();
        clearTimeout(link.handshakeTimer);
        link.handshakeTimer = setTimeout(
          () => this.fail(peer.id, "网络中断，直连已断开，请重试"),
          12_000,
        );
      }
      if (pc.connectionState === "connected") {
        clearTimeout(link.handshakeTimer);
        peer.error = undefined;
        this.update();
        void this.route(peer.id).catch(() => {});
      }
    };
    pc.ondatachannel = (event) => this.attach(peer.id, link, event.channel);
    if (initiator) {
      this.attach(
        peer.id,
        link,
        pc.createDataChannel("control", { ordered: true }),
      );
      this.attach(
        peer.id,
        link,
        pc.createDataChannel("files", { ordered: true }),
      );
      link.chain = link.chain
        .then(async () => {
          await pc.setLocalDescription(await pc.createOffer());
          this.signal(peer.id, "description", pc.localDescription);
        })
        .catch(() => this.fail(peer.id, "无法建立直连，请重试"));
    }
  }
  private attach(id: string, link: Link, channel: RTCDataChannel) {
    if (channel.label === "control") link.control = channel;
    else if (channel.label === "files") {
      link.bulk = channel;
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = 256 * 1024;
    } else {
      channel.close();
      return;
    }
    channel.onopen = () => {
      if (
        link.control?.readyState === "open" &&
        link.bulk?.readyState === "open"
      ) {
        clearTimeout(link.handshakeTimer);
        const peer = this.state.peers[id];
        peer.state = "connected";
        peer.error = undefined;
        this.sendControl(id, { type: "catalog", files: this.state.shared });
        this.update();
      }
    };
    channel.onclose = () => {
      if (!link.closed) this.fail(id, "对方连接已关闭，请重新连接");
    };
    channel.onerror = () => {
      if (!link.closed) this.fail(id, "直连通道发生错误，请重试");
    };
    channel.onmessage = (event) => {
      try {
        if (channel.label === "control")
          this.control(id, JSON.parse(event.data));
        else this.receive(id, event.data);
      } catch (error) {
        this.fail(id, `传输协议异常：${(error as Error).message}`);
      }
    };
  }
  private async route(id: string) {
    const link = this.links.get(id);
    if (!link) return;
    const stats = await link.pc.getStats();
    let selected: any;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId)
        selected = stats.get(report.selectedCandidatePairId);
    });
    const local = selected && stats.get(selected.localCandidateId);
    const remote = selected && stats.get(selected.remoteCandidateId);
    const peer = this.state.peers[id];
    if (!peer || link.closed) return;
    peer.route =
      local?.candidateType === "host" && remote?.candidateType === "host"
        ? "直接连接（主机候选）"
        : "直接连接";
    this.update();
  }
  private fail(id: string, reason: string) {
    const peer = this.state.peers[id];
    if (!peer) return;
    this.closeLink(id, reason);
    peer.state = "failed";
    peer.error = reason;
    try {
      this.command("pair.disconnect", id);
    } catch {
      /* Signal may be unavailable. */
    }
    this.update();
  }
  private closeLink(id: string, reason: string) {
    const link = this.links.get(id);
    if (!link) return;
    link.closed = true;
    clearTimeout(link.handshakeTimer);
    for (const timer of link.requested.values()) clearTimeout(timer);
    link.requested.clear();
    link.control?.close();
    link.bulk?.close();
    link.pc.close();
    for (const out of [...link.queue, ...(link.sending ? [link.sending] : [])])
      clearTimeout(out.timer);
    if (link.incoming) {
      clearTimeout(link.incoming.timer);
      if (link.incoming.reserved) this.retained -= link.incoming.view.size;
      link.incoming.chunks = [];
    }
    const peer = this.state.peers[id];
    for (const item of peer?.items || []) {
      if (item.kind === "message" && item.status === "sending") {
        item.status = "failed";
        clearTimeout(this.messageTimers.get(item.id));
        this.messageTimers.delete(item.id);
      }
      if (
        item.kind === "file" &&
        !["complete", "cancelled", "failed"].includes(item.status)
      ) {
        item.status = "failed";
        item.error = reason;
      }
    }
    this.links.delete(id);
  }
  private sendControl(id: string, data: unknown) {
    const channel = this.links.get(id)?.control;
    if (channel?.readyState !== "open") throw new Error("设备尚未连接");
    channel.send(JSON.stringify(data));
  }
  sendMessage(id: string, text: string) {
    text = text.trim();
    if (!text) return false;
    if (text.length > 8000) {
      this.notice("消息最多 8000 个字符");
      return false;
    }
    const item = {
      kind: "message" as const,
      id: uid(),
      peerId: id,
      mine: true,
      text,
      time: Date.now(),
      status: "sending" as const,
    };
    try {
      this.sendControl(id, { type: "chat", id: item.id, text });
      this.state.peers[id].items.push(item);
      this.messageTimers.set(
        item.id,
        setTimeout(() => {
          const current = this.state.peers[id]?.items.find(
            (value) => value.id === item.id,
          );
          if (current?.kind === "message" && current.status === "sending") {
            current.status = "failed";
            this.update();
          }
          this.messageTimers.delete(item.id);
        }, 30_000),
      );
      this.update();
      return true;
    } catch (e) {
      this.notice((e as Error).message);
      return false;
    }
  }
  private control(id: string, data: any) {
    if (!data || typeof data.type !== "string") throw new Error("无效消息");
    const peer = this.state.peers[id],
      link = this.links.get(id);
    if (!peer || !link) return;
    switch (data.type) {
      case "chat":
        if (
          typeof data.text !== "string" ||
          data.text.length > 8000 ||
          typeof data.id !== "string" ||
          data.id.length > 64
        )
          throw new Error("消息过长");
        if (!peer.items.some((item) => item.id === data.id)) {
          peer.items.push({
            kind: "message",
            id: data.id,
            peerId: id,
            mine: false,
            text: data.text,
            time: Date.now(),
            status: "delivered",
          });
          if (this.state.selected !== id) peer.unread++;
        }
        this.sendControl(id, { type: "chat.ack", id: data.id });
        break;
      case "chat.ack": {
        const item = peer.items.find((item) => item.id === data.id);
        if (item?.kind === "message" && item.mine) {
          item.status = "delivered";
          clearTimeout(this.messageTimers.get(item.id));
          this.messageTimers.delete(item.id);
        }
        break;
      }
      case "catalog":
        if (!Array.isArray(data.files) || data.files.length > 100)
          throw new Error("共享目录无效");
        peer.shared = data.files
          .filter(
            (f: any) =>
              typeof f.id === "string" &&
              f.id.length <= 64 &&
              typeof f.name === "string" &&
              f.name.length <= 240 &&
              Number.isSafeInteger(f.size) &&
              f.size >= 0 &&
              f.size <= MAX_FILE,
          )
          .map((f: SharedFile) => ({
            id: f.id,
            name: cleanName(f.name),
            size: f.size,
            type: typeof f.type === "string" ? f.type.slice(0, 100) : "",
          }));
        break;
      case "file.request": {
        const file = this.localFiles.get(data.fileId);
        if (file) this.enqueue(id, [file], data.fileId);
        else
          this.sendControl(id, {
            type: "file.unavailable",
            fileId: data.fileId,
          });
        break;
      }
      case "file.unavailable": {
        clearTimeout(link.requested.get(data.fileId));
        link.requested.delete(data.fileId);
        this.notice("该共享文件已取消，请刷新共享列表");
        break;
      }
      case "file.offer": {
        if (
          link.incoming ||
          typeof data.id !== "string" ||
          data.id.length > 64 ||
          typeof data.name !== "string" ||
          !Number.isSafeInteger(data.size) ||
          data.size < 0 ||
          data.size > MAX_FILE ||
          peer.items.some((item) => item.id === data.id)
        )
          throw new Error("文件信息无效");
        const view: Transfer = {
          kind: "file",
          id: data.id,
          peerId: id,
          mine: false,
          name: cleanName(data.name),
          type: typeof data.mime === "string" ? data.mime.slice(0, 100) : "",
          size: data.size,
          bytes: 0,
          speed: 0,
          time: Date.now(),
          status: "offered",
        };
        link.incoming = { view, chunks: [], reserved: false };
        peer.items.push(view);
        if (this.state.selected !== id) peer.unread++;
        link.incoming.timer = setTimeout(
          () => this.cancelTransfer(id, view.id, "接收超时"),
          TIMEOUT,
        );
        if (data.fileId && link.requested.has(data.fileId)) {
          clearTimeout(link.requested.get(data.fileId));
          link.requested.delete(data.fileId);
          this.acceptFile(id, data.id);
        }
        break;
      }
      case "file.accept": {
        const out = link.sending;
        if (out && out.view.id === data.id && out.view.status === "offered") {
          out.sending = true;
          clearTimeout(out.timer);
          void this.transmit(id, link, out);
        }
        break;
      }
      case "file.cancel": {
        if (link.sending && link.sending.view.id === data.id) {
          const out = link.sending;
          out.view.status = "cancelled";
          out.view.error =
            data.reason === "declined" ? "对方拒绝接收" : "对方已取消";
          clearTimeout(out.timer);
          if (!out.sending) {
            link.sending = undefined;
            this.next(id);
          }
        }
        if (link.incoming?.view.id === data.id)
          this.dropIncoming(link, "对方已取消", "cancelled");
        break;
      }
      case "file.complete": {
        const out = link.sending;
        if (out && out.view.id === data.id) {
          clearTimeout(out.timer);
          out.view.status = "complete";
          out.view.bytes = out.view.size;
          link.sending = undefined;
          this.next(id);
        }
        break;
      }
    }
    this.update();
  }
  sendFiles(id: string, files: File[]) {
    if (this.state.peers[id]?.state !== "connected") {
      this.notice("请先与设备建立连接");
      return;
    }
    this.enqueue(id, files);
  }
  private enqueue(id: string, files: File[], fileId?: string) {
    const link = this.links.get(id);
    if (!link) return;
    if (link.queue.length + files.length > 100) {
      this.notice("最多排队 100 个文件");
      return;
    }
    for (const file of files) {
      if (file.size > MAX_FILE) {
        this.notice(`${file.name} 超过第一版 256 MB 单文件限制`);
        continue;
      }
      const view: Transfer = {
        kind: "file",
        id: uid(),
        peerId: id,
        mine: true,
        name: cleanName(file.name),
        type: file.type,
        size: file.size,
        time: Date.now(),
        bytes: 0,
        speed: 0,
        status: "queued",
      };
      this.state.peers[id].items.push(view);
      const out: Outgoing = { view, file, sending: false };
      (out as Outgoing & { fileId?: string }).fileId = fileId;
      link.queue.push(out);
    }
    this.next(id);
    this.update();
  }
  private next(id: string) {
    const link = this.links.get(id);
    if (!link || link.sending || link.closed) return;
    const out = link.queue.shift();
    if (!out) return;
    link.sending = out;
    out.view.status = "offered";
    this.sendControl(id, {
      type: "file.offer",
      id: out.view.id,
      name: out.view.name,
      size: out.view.size,
      mime: out.file.type,
      fileId: (out as Outgoing & { fileId?: string }).fileId,
    });
    out.timer = setTimeout(
      () => this.cancelTransfer(id, out.view.id, "等待接收超时"),
      TIMEOUT,
    );
  }
  acceptFile(id: string, transferId: string) {
    const link = this.links.get(id),
      incoming = link?.incoming;
    if (
      !link ||
      !incoming ||
      incoming.view.id !== transferId ||
      incoming.reserved
    )
      return;
    if (this.retained + incoming.view.size > MAX_FILE) {
      this.notice(
        "接收区内存不足，请先保存并释放已接收文件（接收区总量 256 MB）",
      );
      this.cancelTransfer(id, transferId, "接收区内存不足");
      return;
    }
    this.retained += incoming.view.size;
    incoming.reserved = true;
    incoming.view.status = "transferring";
    incoming.view.time = Date.now();
    this.resetIncomingTimer(id, link);
    this.sendControl(id, { type: "file.accept", id: transferId });
    this.update();
  }
  private resetIncomingTimer(id: string, link: Link) {
    if (!link.incoming) return;
    clearTimeout(link.incoming.timer);
    link.incoming.timer = setTimeout(() => {
      this.cancelTransfer(id, link.incoming!.view.id, "传输超时");
    }, TIMEOUT);
  }
  private receive(id: string, data: unknown) {
    const link = this.links.get(id);
    if (!link) return;
    if (typeof data === "string") {
      const end = JSON.parse(data);
      const incoming = link.incoming;
      if (end.type === "start") {
        link.inboundWireId = end.id;
        return;
      }
      if (end.type !== "end" || !incoming || incoming.view.id !== end.id)
        return;
      if (!incoming.reserved || incoming.view.bytes !== incoming.view.size) {
        this.cancelTransfer(id, incoming.view.id, "文件长度校验失败");
        return;
      }
      clearTimeout(incoming.timer);
      const blob = new Blob(incoming.chunks, {
        type: "application/octet-stream",
      });
      incoming.chunks = [];
      incoming.view.url = URL.createObjectURL(blob);
      incoming.view.status = "complete";
      this.sendControl(id, { type: "file.complete", id: incoming.view.id });
      link.incoming = undefined;
      this.update();
      return;
    }
    const incoming = link.incoming;
    if (!incoming?.reserved || link.inboundWireId !== incoming.view.id) return;
    if (
      !(data instanceof ArrayBuffer) ||
      data.byteLength > CHUNK ||
      incoming.view.bytes + data.byteLength > incoming.view.size
    )
      throw new Error("文件数据长度不匹配");
    incoming.chunks.push(data);
    incoming.view.bytes += data.byteLength;
    incoming.view.speed =
      incoming.view.bytes /
      Math.max((Date.now() - incoming.view.time) / 1000, 0.1);
    this.resetIncomingTimer(id, link);
    this.progressUpdate();
  }
  private progressPending = false;
  private progressUpdate() {
    if (this.progressPending) return;
    this.progressPending = true;
    setTimeout(() => {
      this.progressPending = false;
      this.update();
    }, 80);
  }
  private async drain(channel: RTCDataChannel, limit = 512 * 1024) {
    if (channel.readyState !== "open") throw new Error("传输通道已关闭");
    if (channel.bufferedAmount <= limit) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("发送缓冲超时")),
        TIMEOUT,
      );
      const onLow = () => {
        if (channel.bufferedAmount <= limit) finish();
      };
      const onClose = () => finish(new Error("传输通道已关闭"));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose, { once: true });
      onLow();
    });
  }
  private async transmit(id: string, link: Link, out: Outgoing) {
    try {
      out.view.status = "transferring";
      out.view.time = Date.now();
      this.update();
      const channel = link.bulk!;
      channel.send(JSON.stringify({ type: "start", id: out.view.id }));
      for (let offset = 0; offset < out.file.size; offset += CHUNK) {
        if ((out.view.status as string) === "cancelled" || link.closed) break;
        await this.drain(channel);
        const chunk = await out.file
          .slice(offset, offset + CHUNK)
          .arrayBuffer();
        if ((out.view.status as string) === "cancelled" || link.closed) break;
        channel.send(chunk);
        out.view.bytes = offset + chunk.byteLength;
        out.view.speed =
          out.view.bytes / Math.max((Date.now() - out.view.time) / 1000, 0.1);
        this.progressUpdate();
      }
      if (link.closed) return;
      // End marker travels on the binary channel, preserving ordering with all chunks.
      channel.send(JSON.stringify({ type: "end", id: out.view.id }));
      out.sending = false;
      if ((out.view.status as string) === "cancelled") {
        link.sending = undefined;
        this.next(id);
      } else
        out.timer = setTimeout(
          () => this.fail(id, "对方未确认文件接收完成，请重新连接"),
          TIMEOUT,
        );
      this.update();
    } catch {
      if (!link.closed) this.fail(id, "文件发送中断，请重新连接后重试");
    }
  }
  private dropIncoming(
    link: Link,
    error: string,
    status: "failed" | "cancelled",
  ) {
    const incoming = link.incoming;
    if (!incoming) return;
    clearTimeout(incoming.timer);
    if (incoming.reserved) this.retained -= incoming.view.size;
    incoming.chunks = [];
    incoming.view.status = status;
    incoming.view.error = error;
    link.incoming = undefined;
  }
  cancelTransfer(id: string, transferId: string, reason = "已取消") {
    const link = this.links.get(id);
    if (!link) return;
    const index = link.queue.findIndex((out) => out.view.id === transferId);
    if (index >= 0) {
      link.queue[index].view.status = "cancelled";
      link.queue.splice(index, 1);
      this.update();
      return;
    }
    try {
      this.sendControl(id, {
        type: "file.cancel",
        id: transferId,
        reason: reason === "已拒绝" ? "declined" : "cancelled",
      });
    } catch {
      /* Channel already closed. */
    }
    if (link.incoming?.view.id === transferId)
      this.dropIncoming(link, reason, "cancelled");
    if (link.sending?.view.id === transferId) {
      const out = link.sending;
      clearTimeout(out.timer);
      out.view.status = "cancelled";
      out.view.error = reason;
      if (!out.sending) {
        link.sending = undefined;
        this.next(id);
      }
    }
    this.update();
  }
  share(files: File[]) {
    if (this.localFiles.size + files.length > 100) {
      this.notice("最多共享 100 个文件");
      return;
    }
    for (const file of files) {
      if (file.size > MAX_FILE) {
        this.notice(`${file.name} 超过 256 MB 限制`);
        continue;
      }
      const id = uid();
      this.localFiles.set(id, file);
      this.state.shared.push({
        id,
        name: cleanName(file.name),
        size: file.size,
        type: file.type,
      });
    }
    this.publish();
    this.update();
  }
  unshare(fileId: string) {
    this.localFiles.delete(fileId);
    this.state.shared = this.state.shared.filter((file) => file.id !== fileId);
    this.publish();
    this.update();
  }
  private publish() {
    for (const peer of Object.values(this.state.peers))
      if (peer.state === "connected")
        this.sendControl(peer.id, {
          type: "catalog",
          files: this.state.shared,
        });
  }
  download(id: string, fileId: string) {
    const link = this.links.get(id);
    if (!link || link.requested.has(fileId)) return;
    const now = Date.now(),
      last = this.downloads.get(`${id}:${fileId}`) || 0;
    if (now - last < 1000) return;
    this.downloads.set(`${id}:${fileId}`, now);
    try {
      this.sendControl(id, { type: "file.request", fileId });
      link.requested.set(
        fileId,
        setTimeout(() => {
          link.requested.delete(fileId);
          this.notice("下载请求超时，请确认对方仍在线");
        }, TIMEOUT),
      );
    } catch (e) {
      this.notice((e as Error).message);
    }
  }
  release(id: string, transferId: string) {
    const item = this.state.peers[id]?.items.find(
      (item) => item.id === transferId,
    );
    if (item?.kind === "file" && item.url) {
      URL.revokeObjectURL(item.url);
      item.url = undefined;
      this.retained -= item.size;
      item.error = "文件已从接收区释放";
      this.update();
    }
  }
  dispose() {
    this.disposed = true;
    window.removeEventListener("hashchange", this.captureInvite);
    clearTimeout(this.reconnect);
    this.ws?.close();
    for (const id of this.links.keys()) this.closeLink(id, "页面已关闭");
    for (const peer of Object.values(this.state.peers))
      for (const item of peer.items)
        if (item.kind === "file" && item.url) URL.revokeObjectURL(item.url);
  }
}

export const client = new NearbyClient();
