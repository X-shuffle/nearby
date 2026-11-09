import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Cloud,
  Copy,
  Download,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderPlus,
  Link,
  LoaderCircle,
  Menu,
  Monitor,
  Network,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  Upload,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { client } from "./client";
import {
  formatBytes,
  type ChatItem,
  type Peer,
  type SharedFile,
  type Transfer,
} from "./model";
import "./style.css";

const stateLabel = {
  idle: "在线",
  outgoing: "等待对方确认",
  incoming: "请求连接",
  connecting: "正在建立直连",
  connected: "直接连接 · 加密传输",
  failed: "直连失败",
  rejected: "对方已拒绝",
  expired: "请求已过期",
  offline: "已离线",
};
const time = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
function DeviceIcon({
  platform,
  size = 23,
}: {
  platform?: string;
  size?: number;
}) {
  return /iPhone|Android|iPad/.test(platform || "") ? (
    <Smartphone size={size} strokeWidth={1.6} />
  ) : (
    <Monitor size={size} strokeWidth={1.6} />
  );
}
function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const Icon = /zip|rar|7z|tar|gz/.test(ext)
    ? FileArchive
    : /png|jpg|jpeg|gif|webp|heic/.test(ext)
      ? FileImage
      : /xlsx|xls|csv/.test(ext)
        ? FileSpreadsheet
        : /pdf|md|txt|docx/.test(ext)
          ? FileText
          : File;
  return (
    <span className={`file-icon ${/xlsx|xls|csv/.test(ext) ? "green" : ""}`}>
      <Icon size={24} strokeWidth={1.5} />
      <small>{ext.slice(0, 4).toUpperCase() || "FILE"}</small>
    </span>
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" onClick={close} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function App() {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [inspector, setInspector] = useState(() => window.innerWidth > 1180);
  const [mobileList, setMobileList] = useState(false);
  const [sharedTab, setSharedTab] = useState<"theirs" | "mine">("theirs");
  const [dialog, setDialog] = useState<"help" | "rename" | "invite" | null>(
    null,
  );
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragCount = useRef(0);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    shareInput = useRef<HTMLInputElement>(null),
    messages = useRef<HTMLDivElement>(null);
  const peer = state.selected ? state.peers[state.selected] : undefined;
  const peers = Object.values(state.peers).sort(
    (a, b) =>
      Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
  const online = peers.filter((peer) => peer.online);
  const recent = peers.filter((peer) => !peer.online && peer.items.length > 0);
  const connected = peer?.state === "connected";
  useEffect(() => {
    void client.start();
    return () => client.dispose();
  }, []);
  useEffect(() => {
    messages.current?.scrollTo({ top: messages.current.scrollHeight });
  }, [peer?.id, peer?.items.length]);
  useEffect(() => {
    if (state.invite) setCopied(false);
  }, [state.invite]);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      client.notice("无法访问剪贴板，请手动选择并复制链接");
    }
  }
  function openInvite() {
    client.invite();
    setDialog("invite");
  }
  function select(id: string) {
    client.select(id);
    setMobileList(false);
    setText("");
  }
  function send() {
    if (!connected || !peer || !text.trim()) return;
    if (client.sendMessage(peer.id, text)) setText("");
  }
  function addShared(files: File[]) {
    client.share(files);
    setInspector(true);
    setSharedTab("mine");
  }
  const requests = peers.filter((peer) => peer.state === "incoming");
  return (
    <div className="app">
      <header className="global-header">
        <a className="brand" href="/" aria-label="近邻首页">
          <span className="brand-mark">
            <ArrowRightLeft size={31} strokeWidth={2.8} />
          </span>
          <span>
            <strong>近邻</strong>
            <small>NEARBY</small>
          </span>
        </a>
        <span className="brand-rule" />
        <p className="tagline">文件直达，聊在身边</p>
        <div className="header-actions">
          <span className={`cloud-status ${state.cloud}`}>
            <i className="dot" />
            <span>
              {state.cloud === "connected"
                ? "云端已连接"
                : state.cloud === "connecting"
                  ? "连接云端中"
                  : "云端已断开"}
            </span>
          </span>
          <span className="direct-badge">
            <ShieldCheck size={13} />
            仅直连
          </span>
          <span className="header-rule" />
          <button
            className="icon-button"
            aria-label="使用帮助"
            onClick={() => setDialog("help")}
          >
            <CircleHelp size={21} strokeWidth={1.6} />
          </button>
          <button
            className="my-avatar"
            aria-label="修改设备名称"
            onClick={() => {
              setName(state.self?.name || "我的电脑");
              setDialog("rename");
            }}
          >
            {state.self?.name.slice(0, 1) || "我"}
          </button>
        </div>
      </header>
      {state.notice && (
        <div className="notice" role="status">
          <CircleHelp size={16} />
          <span>{state.notice}</span>
          <button
            className="icon-button"
            onClick={() => client.notice()}
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {!state.supported && (
        <div className="notice danger" role="alert">
          当前浏览器不支持所需的 WebRTC 功能，请使用新版 Chrome、Edge、Safari 或
          Firefox，并通过 HTTPS 打开。
        </div>
      )}
      <div
        className={`shell ${inspector ? "has-inspector" : ""} ${mobileList || !peer ? "mobile-list" : ""}`}
      >
        <aside className="sidebar" aria-label="设备列表">
          <div className="sidebar-heading">
            <h2>附近的设备</h2>
            <button
              className="icon-button"
              aria-label="刷新连接"
              title="重连云端并刷新设备"
              onClick={() => client.retryCloud()}
            >
              <RefreshCw size={18} />
            </button>
          </div>
          <div className="network-summary">
            <Network size={27} strokeWidth={1.5} />
            <div>
              <strong>
                {state.cloud === "connected"
                  ? "已自动加入网络"
                  : "正在寻找你的网络"}
              </strong>
              <span>
                {state.cloud === "connected"
                  ? `同网络出口 · ${online.length + 1} 台设备`
                  : "连接后自动发现在线设备"}
              </span>
            </div>
            {state.cloud === "connected" && <span className="tiny-dot" />}
          </div>
          <p className="network-footnote">
            <CircleHelp size={12} />
            {state.ipv6
              ? "IPv6 网络建议通过邀请链接配对"
              : "同网络出口不一定是同一 Wi-Fi"}
          </p>
          <div className="section-heading">
            <h3>在线设备</h3>
            <span className="count">{online.length}</span>
          </div>
          <div className="device-list">
            <div role="group" aria-label="在线设备">
              {online.map((device, index) => (
                <DeviceEntry
                  key={device.id}
                  device={device}
                  index={index}
                  selected={peer?.id === device.id}
                  onSelect={select}
                />
              ))}
            </div>
            {online.length === 0 && (
              <div className="discovery-empty">
                <Wifi size={27} strokeWidth={1.3} />
                <p>还没有发现其他设备</p>
                <span>
                  在另一台设备打开本网页，
                  <br />
                  或通过链接邀请对方。
                </span>
              </div>
            )}
            {recent.length > 0 && (
              <div
                className="recent-conversations"
                role="group"
                aria-label="最近会话"
              >
                <div className="section-heading">
                  <h3>最近会话</h3>
                  <span className="count">{recent.length}</span>
                </div>
                {recent.map((device, index) => (
                  <DeviceEntry
                    key={device.id}
                    device={device}
                    index={index}
                    selected={peer?.id === device.id}
                    onSelect={select}
                  />
                ))}
              </div>
            )}
          </div>
          <button
            className="invite-button"
            onClick={openInvite}
            disabled={state.cloud !== "connected"}
          >
            <Link size={17} />
            通过链接邀请
            <ArrowRight size={14} />
          </button>
          <div className="sidebar-bottom">
            <button
              className="self-device"
              onClick={() => {
                setName(state.self?.name || "我的电脑");
                setDialog("rename");
              }}
              disabled={!state.self}
            >
              <span className="self-icon">
                <DeviceIcon platform={state.self?.platform} size={21} />
              </span>
              <span>
                <strong>{state.self?.name || "我的设备"}</strong>
                <small>{state.self?.platform || "正在连接…"} · 本机</small>
              </span>
              <Pencil size={14} />
            </button>
            <p>
              <ShieldCheck size={15} />
              文件不经过云端服务器
            </p>
          </div>
        </aside>
        <main
          className="conversation"
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              dragCount.current++;
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (--dragCount.current <= 0) {
              dragCount.current = 0;
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragCount.current = 0;
            setDragging(false);
            if (peer && connected)
              client.sendFiles(peer.id, Array.from(event.dataTransfer.files));
            else client.notice("请先选择设备并建立连接，再发送文件");
          }}
        >
          {peer ? (
            <>
              <div className="conversation-header">
                <button
                  className="icon-button mobile-back"
                  onClick={() => setMobileList(true)}
                  aria-label="返回设备列表"
                >
                  <ArrowLeft size={20} />
                </button>
                <span className="conversation-avatar">
                  <DeviceIcon platform={peer.platform} size={25} />
                </span>
                <div className="conversation-title">
                  <h1>{peer.name}</h1>
                  <p className={connected ? "success-text" : ""}>
                    {connected && <i className="dot" />}
                    {["connecting", "outgoing"].includes(peer.state) && (
                      <LoaderCircle size={13} className="spin" />
                    )}
                    {stateLabel[peer.state]}
                  </p>
                </div>
                <div className="conversation-actions">
                  {connected ? (
                    <button
                      className="text-button disconnect"
                      onClick={() => client.disconnect(peer.id)}
                    >
                      断开连接
                    </button>
                  ) : (
                    !["incoming", "connecting", "outgoing", "offline"].includes(
                      peer.state,
                    ) && (
                      <button
                        className="button primary small"
                        onClick={() => client.request(peer.id)}
                      >
                        请求连接
                      </button>
                    )
                  )}
                  {["connecting", "outgoing"].includes(peer.state) &&
                    peer.items.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() => client.disconnect(peer.id)}
                      >
                        取消请求
                      </button>
                    )}
                  <button
                    className={`button subtle small ${inspector ? "active" : ""}`}
                    onClick={() => {
                      setInspector(!inspector);
                      setSharedTab("theirs");
                    }}
                    aria-label="打开共享文件"
                  >
                    <Folder size={17} />
                    <span>共享文件</span>
                  </button>
                </div>
              </div>
              <div className="privacy-strip">
                <ShieldCheck size={15} />
                <span>
                  {connected
                    ? "聊天与文件通过设备直连传输"
                    : "连接前需要对方确认，文件不会上传到服务器"}
                </span>
              </div>
              {peer.error && (
                <div className="connection-error" role="alert">
                  <WifiOff size={18} />
                  <span>{peer.error}</span>
                  {peer.online && peer.state === "failed" && (
                    <button
                      className="text-button"
                      onClick={() => client.request(peer.id)}
                    >
                      重试连接
                    </button>
                  )}
                </div>
              )}
              <div
                className="messages"
                ref={messages}
                aria-label="聊天记录"
                aria-live="polite"
              >
                {peer.items.length > 0 && (
                  <div className="date-divider">
                    <span />
                    今天
                    <span />
                  </div>
                )}
                {peer.items.map((item) => (
                  <ChatRow key={item.id} item={item} peer={peer} />
                ))}
                {peer.items.length === 0 && (
                  <div className="chat-empty">
                    <span className="empty-device">
                      <DeviceIcon platform={peer.platform} size={37} />
                    </span>
                    <h2>
                      {connected
                        ? "连接好了，聊点什么？"
                        : peer.state === "outgoing"
                          ? "等待对方接受连接"
                          : peer.state === "connecting"
                            ? "正在建立设备直连"
                            : peer.state === "incoming"
                              ? "这台设备想与你连接"
                              : `与${peer.name}建立连接`}
                    </h2>
                    <p>
                      {connected
                        ? "发送一条消息，或把文件拖进来。"
                        : peer.state === "outgoing"
                          ? "对方确认后，即可聊天和传输文件。"
                          : peer.state === "connecting"
                            ? "正在尝试直接连接，不使用中继服务器。"
                            : peer.state === "incoming"
                              ? "接受后，双方才能聊天和交换共享文件列表。"
                              : "双方确认后，消息与文件将在设备之间直接传输。"}
                    </p>
                    {peer.state === "incoming" ? (
                      <div className="empty-actions">
                        <button
                          className="button"
                          onClick={() => client.respond(peer.id, false)}
                        >
                          拒绝
                        </button>
                        <button
                          className="button primary"
                          onClick={() => client.respond(peer.id, true)}
                        >
                          接受连接
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    ) : (
                      ["idle", "rejected", "expired", "failed"].includes(
                        peer.state,
                      ) &&
                      peer.online && (
                        <button
                          className="button primary"
                          onClick={() => client.request(peer.id)}
                        >
                          请求连接
                          <ArrowRight size={16} />
                        </button>
                      )
                    )}
                    {["connecting", "outgoing"].includes(peer.state) && (
                      <button
                        className="text-button"
                        onClick={() => client.disconnect(peer.id)}
                      >
                        取消连接
                      </button>
                    )}
                  </div>
                )}
              </div>
              {connected && (
                <div className="drop-hint">
                  <Upload size={15} />
                  将文件拖到这里，直接发送<span>单文件最大 256 MB</span>
                </div>
              )}
              <div className={`composer ${!connected ? "disabled" : ""}`}>
                <div className="composer-toolbar">
                  <button
                    onClick={() => fileInput.current?.click()}
                    disabled={!connected}
                  >
                    <Paperclip size={19} />
                    发送文件
                  </button>
                  <button onClick={() => shareInput.current?.click()}>
                    <FolderPlus size={19} />
                    共享文件
                  </button>
                  <span className="toolbar-note">设备直连 · 无中继</span>
                </div>
                <textarea
                  aria-label="消息内容"
                  placeholder={
                    connected
                      ? "发送消息，或拖入文件…"
                      : "连接成功后即可发送消息"
                  }
                  disabled={!connected}
                  value={text}
                  maxLength={8000}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>Enter 发送 · Shift + Enter 换行</span>
                  <button
                    className="button primary send-button"
                    onClick={send}
                    disabled={!connected || !text.trim()}
                  >
                    发送
                    <Send size={16} />
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="empty-topline">
                <span>
                  <Network size={16} />
                  自动发现 · 安全直连
                </span>
                <button
                  className="text-button"
                  onClick={() => setDialog("help")}
                >
                  了解近邻
                  <ChevronRight size={15} />
                </button>
              </div>
              <div className="welcome">
                <div className="welcome-mark">
                  <ArrowRightLeft size={43} strokeWidth={1.7} />
                </div>
                <span className="eyebrow">HELLO, NEARBY</span>
                <h1>让设备，在这里相遇。</h1>
                <p>
                  同一个网络，打开同一个网页。
                  <br />
                  发现彼此，聊几句，再把文件直接传过去。
                </p>
                <div className="welcome-steps">
                  <div>
                    <span>01</span>
                    <strong>发现设备</strong>
                    <p>自动寻找同网络出口的设备</p>
                  </div>
                  <ArrowRight size={18} />
                  <div>
                    <span>02</span>
                    <strong>确认连接</strong>
                    <p>对方接受，建立安全直连</p>
                  </div>
                  <ArrowRight size={18} />
                  <div>
                    <span>03</span>
                    <strong>开始分享</strong>
                    <p>聊天、传文件、共享下载</p>
                  </div>
                </div>
                <button
                  className="button primary"
                  onClick={openInvite}
                  disabled={state.cloud !== "connected"}
                >
                  <Link size={17} />
                  邀请另一台设备
                  <ArrowRight size={16} />
                </button>
                <span className="welcome-note">
                  无需注册 · 文件不上传云端 · 不使用中继
                </span>
              </div>
              <div className="welcome-footer">
                <ShieldCheck size={16} />
                <span>云端负责牵线，文件直达对方设备。</span>
              </div>
            </>
          )}
          {dragging && (
            <div className="drop-overlay">
              <Upload size={40} />
              <h2>
                {connected ? `松开，发送给${peer?.name}` : "请先建立设备连接"}
              </h2>
              <p>文件通过设备直连传输</p>
            </div>
          )}
        </main>
        {inspector && (
          <>
            <button
              className="inspector-backdrop"
              aria-label="关闭共享文件面板"
              onClick={() => setInspector(false)}
            />
            <aside className="inspector" aria-label="共享文件面板">
              <div className="inspector-heading">
                <h2>
                  共享文件
                  <span className="count">
                    {sharedTab === "mine"
                      ? state.shared.length
                      : peer?.shared.length || 0}
                  </span>
                </h2>
                <button
                  className="icon-button"
                  aria-label="关闭共享文件"
                  onClick={() => setInspector(false)}
                >
                  <X size={19} />
                </button>
              </div>
              <div className="tabs" role="tablist" aria-label="共享文件来源">
                <button
                  role="tab"
                  aria-selected={sharedTab === "theirs"}
                  className={sharedTab === "theirs" ? "selected" : ""}
                  onClick={() => setSharedTab("theirs")}
                >
                  对方共享
                </button>
                <button
                  role="tab"
                  aria-selected={sharedTab === "mine"}
                  className={sharedTab === "mine" ? "selected" : ""}
                  onClick={() => setSharedTab("mine")}
                >
                  我的共享
                </button>
              </div>
              <p className="shared-description">
                {sharedTab === "mine"
                  ? "已接受连接的设备可查看并下载"
                  : connected
                    ? "对方在线时，可直接下载"
                    : "连接成功后，查看对方共享的文件"}
              </p>
              <div className="shared-files">
                {(sharedTab === "mine"
                  ? state.shared
                  : connected
                    ? peer.shared
                    : []
                ).map((file) => (
                  <SharedRow
                    key={file.id}
                    file={file}
                    mine={sharedTab === "mine"}
                    peerId={peer?.id}
                  />
                ))}
                {(sharedTab === "mine"
                  ? state.shared.length === 0
                  : !connected || peer.shared.length === 0) && (
                  <div className="shared-empty">
                    <Folder size={29} strokeWidth={1.25} />
                    <strong>
                      {sharedTab === "mine"
                        ? "把文件放在这里"
                        : connected
                          ? "对方还没有共享文件"
                          : "连接后，文件在这里相见"}
                    </strong>
                    <p>
                      {sharedTab === "mine"
                        ? "选择文件后，对方即可按需下载。\n关闭网页后自动停止共享。"
                        : "共享的文件保留在对方设备中，\n下载时直接从对方获取。"}
                    </p>
                    {sharedTab === "mine" && (
                      <button
                        className="button small"
                        onClick={() => shareInput.current?.click()}
                      >
                        <Plus size={15} />
                        添加共享文件
                      </button>
                    )}
                  </div>
                )}
                {sharedTab === "mine" && state.shared.length > 0 && (
                  <button
                    className="text-button add-shared"
                    onClick={() => shareInput.current?.click()}
                  >
                    <Plus size={15} />
                    添加共享文件
                  </button>
                )}
              </div>
              <div className="connection-info">
                <h3>连接信息</h3>
                <dl>
                  <div>
                    <dt>传输方式</dt>
                    <dd>{connected ? "WebRTC 直连" : "等待连接"}</dd>
                  </div>
                  <div>
                    <dt>中继服务器</dt>
                    <dd>未启用</dd>
                  </div>
                  <div>
                    <dt>连接状态</dt>
                    <dd className={connected ? "success-text" : ""}>
                      {connected && <i className="dot" />}
                      {peer
                        ? stateLabel[peer.state].split(" · ")[0]
                        : "未选择设备"}
                    </dd>
                  </div>
                </dl>
                <p>
                  <CircleHelp size={13} />
                  <span>直连失败时会提示重试，不经过中继。</span>
                </p>
              </div>
            </aside>
          </>
        )}
      </div>
      {requests.length > 0 &&
        (!peer || peer.state !== "incoming" || peer.items.length > 0) && (
          <div className="incoming-requests" aria-label="连接请求">
            {requests.map((request) => (
              <div className="incoming-card" key={request.id}>
                <span className="request-avatar">
                  <DeviceIcon platform={request.platform} />
                </span>
                <div>
                  <strong>{request.name}</strong>
                  <p>请求与你建立连接</p>
                </div>
                <button
                  className="icon-button"
                  aria-label={`拒绝 ${request.name}`}
                  onClick={() => client.respond(request.id, false)}
                >
                  <X size={18} />
                </button>
                <button
                  className="button primary small"
                  onClick={() => {
                    client.respond(request.id, true);
                    setMobileList(false);
                  }}
                >
                  接受
                </button>
              </div>
            ))}
          </div>
        )}
      <input
        ref={fileInput}
        type="file"
        className="visually-hidden"
        multiple
        aria-label="选择发送文件"
        onChange={(event) => {
          if (peer && event.target.files)
            client.sendFiles(peer.id, Array.from(event.target.files));
          event.target.value = "";
        }}
      />
      <input
        ref={shareInput}
        type="file"
        className="visually-hidden"
        multiple
        aria-label="选择共享文件"
        onChange={(event) => {
          if (event.target.files) addShared(Array.from(event.target.files));
          event.target.value = "";
        }}
      />
      {dialog === "rename" && (
        <Modal title="给设备起个名字" close={() => setDialog(null)}>
          <p className="modal-description">
            让同网络的朋友更容易找到你。名称会对发现范围内的设备可见。
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) {
                client.rename(name.trim());
                setDialog(null);
              }
            }}
          >
            <label className="field-label" htmlFor="device-name">
              设备名称
            </label>
            <input
              className="text-input"
              id="device-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={24}
              autoFocus
              required
            />
            <div className="modal-footer">
              <button
                type="button"
                className="button"
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={!name.trim()}
              >
                保存名称
              </button>
            </div>
          </form>
        </Modal>
      )}
      {dialog === "invite" && (
        <Modal title="邀请另一台设备" close={() => setDialog(null)}>
          <p className="modal-description">
            将链接发给对方，在浏览器打开后即可发现彼此，仍需确认连接。链接 10
            分钟内有效，仅可使用一次。
          </p>
          <div className="invite-qr">
            {state.invite ? (
              <QRCodeSVG
                value={state.invite}
                size={160}
                level="M"
                marginSize={2}
                title="扫码加入近邻"
              />
            ) : (
              <LoaderCircle className="spin" size={24} />
            )}
            <p>用另一台设备扫码打开</p>
          </div>
          <label className="field-label" htmlFor="invite-link">
            邀请链接
          </label>
          <input
            className="text-input invite-link"
            id="invite-link"
            readOnly
            value={state.invite || "正在生成邀请链接…"}
            onFocus={(event) => event.target.select()}
          />
          <div className="invite-note">
            <ShieldCheck size={16} />
            <span>链接可跨网络配对；直连失败时不会使用中继。</span>
          </div>
          <div className="modal-footer">
            <button className="button" onClick={() => client.invite()}>
              重新生成
            </button>
            <button
              className="button primary"
              disabled={!state.invite}
              onClick={() => state.invite && void copy(state.invite)}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
              {copied ? "已复制" : "复制链接"}
            </button>
          </div>
        </Modal>
      )}
      {dialog === "help" && (
        <Modal title="你好，这里是近邻" close={() => setDialog(null)}>
          <div className="help-content">
            <p>
              近邻通过云端寻找同网络出口的设备。选择设备、请求连接，等待对方接受后，即可聊天和传文件。
            </p>
            <h3>文件会经过云端服务器吗？</h3>
            <p>
              聊天正文和文件通过 WebRTC
              直接传输。云端只处理发现、配对和连接信令。双方在局域网内直连成功时，数据留在局域网内。
            </p>
            <h3>为什么没有发现另一台设备？</h3>
            <p>
              公网出口、VPN、代理和 IPv6
              都可能影响自动发现。可通过邀请链接配对。同网络出口也可能包含不认识的设备，请确认对象后再接受连接。
            </p>
            <h3>直连失败怎么办？</h3>
            <p>
              检查防火墙、VPN 和 Wi-Fi 的设备隔离设置。本服务不启用
              TURN，不会通过中继传文件。
            </p>
            <h3>文件保存在哪里？</h3>
            <p>
              主动发送的文件需要对方确认；共享文件由你主动选择，已连接设备可下载。第一版单文件及内存接收区上限均为
              256
              MB。保存后可释放接收区文件。刷新或关闭网页会清除会话和未保存文件。
            </p>
          </div>
          <div className="modal-footer">
            <button className="button primary" onClick={() => setDialog(null)}>
              知道了
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function SharedRow({
  file,
  mine,
  peerId,
}: {
  file: SharedFile;
  mine: boolean;
  peerId?: string;
}) {
  return (
    <div className="shared-row">
      <FileIcon name={file.name} />
      <div>
        <strong title={file.name}>{file.name}</strong>
        <span>{formatBytes(file.size)}</span>
      </div>
      <button
        className="icon-button bordered"
        aria-label={`${mine ? "取消共享" : "下载"} ${file.name}`}
        title={mine ? "取消共享" : "下载文件"}
        onClick={() =>
          mine
            ? client.unshare(file.id)
            : peerId && client.download(peerId, file.id)
        }
      >
        {mine ? <Trash2 size={16} /> : <Download size={17} />}
      </button>
    </div>
  );
}
function ChatRow({ item, peer }: { item: ChatItem; peer: Peer }) {
  return (
    <div className={`chat-row ${item.mine ? "mine" : "theirs"}`}>
      {!item.mine && (
        <span className="chat-avatar">{peer.name.slice(0, 1)}</span>
      )}
      <div className="chat-body">
        {item.kind === "message" ? (
          <>
            <div className="bubble">{item.text}</div>
            <div className="message-meta">
              <time>{time(item.time)}</time>
              {item.mine && (
                <span>
                  {item.status === "delivered" ? (
                    <>
                      <CheckCheck size={12} />
                      已送达
                    </>
                  ) : item.status === "failed" ? (
                    "发送失败"
                  ) : (
                    "发送中"
                  )}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <TransferCard item={item} />
            <div className="message-meta">
              <time>{time(item.time)}</time>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function TransferCard({ item }: { item: Transfer }) {
  const percent = item.size
    ? Math.min(100, Math.floor((item.bytes / item.size) * 100))
    : item.status === "complete"
      ? 100
      : 0;
  const status =
    item.status === "queued"
      ? "排队中"
      : item.status === "offered"
        ? item.mine
          ? "等待对方接收"
          : "请求向你发送文件"
        : item.status === "complete"
          ? item.mine
            ? "对方已接收"
            : "已接收"
          : item.status === "cancelled"
            ? item.error || "已取消"
            : item.status === "failed"
              ? item.error || "传输失败"
              : `${item.mine ? "正在发送" : "正在接收"} · ${formatBytes(item.speed)}/s`;
  return (
    <article
      className={`transfer-card ${item.status}`}
      aria-label={`文件 ${item.name}`}
    >
      <div className="transfer-heading">
        <FileIcon name={item.name} />
        <div>
          <strong title={item.name}>{item.name}</strong>
          <span>
            {formatBytes(item.size)} ·{" "}
            {item.name.split(".").pop()?.toUpperCase() || "文件"}
          </span>
        </div>
      </div>
      {item.status === "transferring" && (
        <>
          <progress
            max={100}
            value={percent}
            aria-label={`${item.name} 传输进度`}
          />
          <div className="transfer-progress">
            <span>
              {formatBytes(item.bytes)} / {formatBytes(item.size)}
            </span>
            <span>{percent}%</span>
          </div>
        </>
      )}
      <div className="transfer-bottom">
        <span className={item.status === "complete" ? "success-text" : ""}>
          {item.status === "complete" && <Check size={14} />} {status}
        </span>
        <div className="transfer-actions">
          {item.status === "offered" && !item.mine && (
            <>
              <button
                className="text-button"
                onClick={() =>
                  client.cancelTransfer(item.peerId, item.id, "已拒绝")
                }
              >
                拒绝
              </button>
              <button
                className="button primary small"
                onClick={() => client.acceptFile(item.peerId, item.id)}
              >
                接收文件
              </button>
            </>
          )}
          {!["complete", "failed", "cancelled"].includes(item.status) &&
            (item.mine || item.status !== "offered") && (
              <button
                className="button small"
                onClick={() => client.cancelTransfer(item.peerId, item.id)}
              >
                取消
              </button>
            )}
          {item.url && (
            <>
              <a className="button small" href={item.url} download={item.name}>
                <Download size={14} />
                保存文件
              </a>
              <button
                className="icon-button"
                aria-label={`释放 ${item.name}`}
                title="保存后释放接收区内存"
                onClick={() => client.release(item.peerId, item.id)}
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
      {item.status === "complete" && !item.mine && !item.url && (
        <p className="released-note">{item.error}</p>
      )}
    </article>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

function DeviceEntry({
  device,
  index,
  selected,
  onSelect,
}: {
  device: Peer;
  index: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`device-row ${selected ? "selected" : ""} ${!device.online ? "offline" : ""}`}
      onClick={() => onSelect(device.id)}
    >
      <span className={`device-avatar tone-${index % 3}`}>
        <DeviceIcon platform={device.platform} />
      </span>
      <span className="device-description">
        <strong>{device.name}</strong>
        <small>
          {device.platform} · {stateLabel[device.state]}
        </small>
      </span>
      {device.unread > 0 ? (
        <span className="unread">{device.unread}</span>
      ) : device.state === "incoming" ? (
        <span className="request-dot" />
      ) : (
        device.online && <i className="tiny-dot" />
      )}
    </button>
  );
}
