# 近邻 Nearby

**简体中文** | [English](README.en.md)

文件直达，聊在身边。基于 **Go DDD 单体 + React / TypeScript + WebRTC** 的云端设备发现、聊天和文件直传网页。

用户打开云端网页后，服务根据来源公网出口自动发现在线设备并建立临时房间。设备确认连接后，聊天正文、文件目录和文件内容通过浏览器 WebRTC DataChannel 直接交换。**没有 TURN，没有文件上传接口，也不保存聊天正文。**

## 已实现

- 与已确认设计稿一致的设备 / 会话 / 共享文件三栏界面，适配手机。
- 同公网出口自动发现、临时房间、设备改名、上线下线通知。
- 请求 / 接受 / 拒绝 / 过期 / 取消 / 断开连接，失败提示与重新连接。
- 一对一聊天、应用层送达确认、消息超时失败状态。
- 多文件队列、16 KiB 分块、背压、接收确认、进度、速度、取消、长度校验和保存。
- 浏览器主动选择文件共享，连接后目录可见，按需下载及取消共享。
- 10 分钟有效、一次性随机邀请链接与本地生成二维码，可跨发现范围配对，仍需连接确认。
- Origin 检查、来源 IP 可信代理规则、消息大小与速率限制、房间和连接授权检查。
- 前端资源嵌入 Go 单个可执行文件，以及 Docker Compose + Cloudflare 橙云 HTTPS 部署。

## 开发与构建

要求：Node.js 22.12+（建议 24）、Go 1.24+（建议 1.26）。

```sh
npm ci
go mod download
npm run build
go run ./cmd/server
```

打开 `http://localhost:15789`。这是云端服务的开发预览，不是另一套本地产品模式。可在两个浏览器窗口验证发现和传输。

前端热更新：保持 Go 服务运行，另开终端执行 `npm run dev`，访问 `http://localhost:5173`；Vite 转发 `/api` 与 WebSocket 给 Go。

生成独立程序（先构建前端）：

```sh
make build
./bin/nearby
```

## Docker 部署：Cloudflare 对外 HTTPS，HTTP 回源

```text
浏览器 HTTPS / WSS → Cloudflare 橙云 → HTTP / WS → Nearby 容器 :15789
                                       源站端口 :15789
设备之间的聊天和文件 → WebRTC 直连（不经过上述 HTTP 服务）
```

源站不配置 HTTPS，不运行 Caddy / Nginx 证书服务，不挂载证书卷。Cloudflare 的 **Flexible** 模式对外提供 HTTPS，回源使用 HTTP；回源这一段不加密。[Cloudflare Flexible 文档](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/flexible/)

### 首次部署

服务器需要 Bash、curl、Docker Engine 和 Docker Compose v2.18+。无需在宿主机安装 Node.js 或 Go，镜像采用多阶段构建。

1. 将域名 A 记录指向源站 IP，并在 Cloudflare DNS 中开启橙云代理。
2. Cloudflare 的 SSL/TLS 加密模式设为 **Flexible**，开启 **Always Use HTTPS**；Network 中保持 **WebSockets** 开启。此方案源站不监听 HTTPS，不使用 Full / Full (strict) 模式。
3. 在 Rules → Origin Rules 中新增只匹配 `nearby.x-shuffle.com`（或实际部署域名）的规则，将 **Destination port** 覆盖为 **15789**。此设置仅修改回源端口，对外仍使用标准 HTTPS 443，无需在网址添加端口。[Cloudflare 回源端口说明](https://developers.cloudflare.com/rules/origin-rules/features/#destination-port)
4. 将项目代码放到服务器，执行下方命令；默认发布源站 HTTP 15789 端口。防火墙或安全组应允许 Cloudflare 官方 IP 网段访问该端口，避免绕过代理。

```sh
# 替换成自己的真实域名
./deploy.sh up --domain nearby.your-domain.com
```

脚本自动创建 `.env`、获取 Cloudflare 官方可信代理网段、构建镜像并等待容器健康。完成后访问 `https://你的域名`，不要通过源站 HTTP 地址使用浏览器 P2P 功能。

### 管理命令

```sh
./deploy.sh init --domain nearby.your-domain.com  # 只准备配置，不启动
./deploy.sh check                               # 校验配置，不要求 Docker 引擎启动
./deploy.sh update                              # 当前目录源码更新后，拉取基础镜像并构建部署
./deploy.sh status                              # 查看容器状态
./deploy.sh logs nearby                         # 跟踪日志
./deploy.sh down                                # 停止并移除本项目容器
./deploy.sh refresh-proxies                     # 单独更新 Cloudflare 网段配置
./deploy.sh --help
```

脚本可从任意工作目录调用，固定操作当前项目与 Compose 项目名 `nearby`，同一 Docker 引擎只部署这一套实例。默认等待容器就绪 120 秒，可用 `./deploy.sh up --timeout 300` 调整。

已有 `.env` 不会被覆盖；只有显式使用 `--domain` 才修改域名，其余配置保留。脚本从不执行 `.env` 内容，不会自动安装 Docker、修改防火墙、拉取项目源码或执行全局 Docker 清理。更新会替换容器，已有信令会话需重新连接。启动失败时显示容器状态和最近日志。

### 真实客户端 IP 与自动发现

Go 只信任 `.env.cloudflare` 中的官方代理网段，按可信代理链从右向左解析 `X-Forwarded-For`。不来自可信代理的请求即使伪造该请求头，也不会改变来源 IP。[Cloudflare 请求头说明](https://developers.cloudflare.com/fundamentals/reference/http-headers/)

- `init` 从 `.env.cloudflare.example` 复制网段快照；`up` / `update` 会重新获取官方 IPv4 / IPv6 列表并校验格式，失败时中止部署，保留旧配置。
- `.env.cloudflare` 仅用于 Compose 插值，把网段传给 Go 的 `TRUSTED_PROXIES`，不要将其改为 `0.0.0.0/0` 或信任任意来源。
- 不要在 Cloudflare 开启移除访客 IP 请求头的 Transform，也不要在前面增加会改写来源地址的代理而不调整信任链。
- 本配置面向 Linux 云端 Docker 网络。额外负载均衡、Docker Desktop 或其他地址转换可能改变应用看到的来源地址，部署后需核对，不能通过信任所有 IP 来解决。
- Cloudflare 边缘可能接受 IPv6 访客，即使源站只配置 A 记录。IPv6 设备可能无法按共同 IPv4 出口自动归组，可使用邀请链接配对；不按猜测的 IPv6 前缀合并设备。
- Go 返回 `Cache-Control: no-store`，Cloudflare 的额外缓存规则也应绕过 `/api/*`。WebSocket 断开后会自动重连。[Cloudflare WebSocket 文档](https://developers.cloudflare.com/network/websockets/)

已有部署请将 `.env` 中的 `ORIGIN_HTTP_PORT` 改为 `15789` 后再更新；脚本保留已有 `.env`，不会自动覆盖旧值。服务器只需为本服务开放源站 TCP 15789，不占用已有 HTTP 80 服务。

部署脚本与配置已提供；尚未执行真实云端部署。容器健康检查只验证源站 HTTP 服务，对外 HTTPS、橙云代理、真实客户端 IP 和证书状态需要实际域名验证。

脚本测试（模拟 Docker，不会启动或删除真实容器）：

```sh
python3 -m unittest discover -s tests -p 'test_deploy.py' -v
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADDR` | `:15789` | Go 监听地址 |
| `TRUSTED_PROXIES` | 直接运行为空；Docker 由脚本设置 | Cloudflare 官方代理 CIDR，仅这些来源可提供真实 IP 链 |
| `ALLOWED_ORIGINS` | 同源 | 额外允许的 WebSocket Origin 主机模式，避免配置通配符 |
| `DISCOVERY_WS_URL` | 当前站点 `/api/ws` | 可选的 `wss://v4.example.com/api/ws`，仅 A 记录入口需反代到**同一个服务实例** |
| `STUN_URLS` | 空 | 可选、逗号分隔、客户端可访问的 `stun:` / `stuns:` 地址；`turn:` 会导致启动失败 |

默认仅使用主机候选，适合允许互通的局域网。STUN 只是帮助发现可用公网地址，不承载文件，也不是中继。没有配置可达 STUN 时，跨网络邀请并不保证能直连。项目从不自动切换到 TURN。

## 网络与数据边界

- **同公网出口不等于同 Wi-Fi**：公司、学校和运营商 CGNAT 可能误分组；VPN、代理、IPv6 可能漏分组。前端明确提示，自动发现不构成身份验证。
- IPv6 使用完整来源地址作为发现键，不按猜测的 `/64` 合并陌生设备；建议采用 IPv4 发现入口或邀请链接。
- 房间键使用进程随机密钥对 IP 做 HMAC，客户端不会收到原始来源 IP。服务运行中仍需处理来源 IP，WebRTC 信令也可能包含网络信息。
- 对方接受配对前，不能交换 WebRTC 信令，也看不到共享目录。共享目录只通过直连通道发布给已连接设备。
- “直接连接”不等于已确认“局域网连接”。页面不根据候选类型误标同 Wi-Fi。
- Wi-Fi AP 隔离、防火墙、VPN、浏览器策略可导致直连失败；20 秒协商超时明确提示重试。
- 第一版**单文件最大 256 MiB；整个页面未释放的接收文件与正在接收文件总量也限制为 256 MiB**。接收文件驻留内存，点击保存后可释放。尚未实现大文件落盘流式接收与断点续传。
- 聊天记录、未保存的文件、共享选择只存在于当前页面；刷新或关闭页面会清除。操作系统是否成功落盘由浏览器下载处理，不自动打开文件。
- 云端暂时断开时，已建立的 P2P 通道可继续工作；重新注册云端会话会分配新设备身份，旧连接关闭并需重新确认。
- 服务为单实例内存状态。重启会清理房间与配对；多副本需补共享状态与跨实例消息路由，不能直接负载均衡扩容。

## DDD 结构

```text
cmd/server/                         启动、配置与依赖组装
internal/discovery/domain/         设备实体与名称规则
internal/room/domain/              自动房间聚合、成员容量
internal/pairing/domain/           配对聚合、状态机与信令授权
internal/session/application/      跨领域会话用例、仓储接口、交付事件
internal/session/infrastructure/   内存事务仓储
internal/interfaces/httpapi/       HTTP / WebSocket 适配、来源解析、消息投递
web/src/                          React 界面与浏览器 P2P 客户端
web/embed.go                      静态资源嵌入
```

领域层不依赖 HTTP、WebSocket、前端或具体仓储。应用层编排领域对象，返回与传输协议无关的交付事件。仓储在单进程中串行化内存操作，网络适配器保持事件投递次序。聊天和文件数据通道属于浏览器端，不创建服务器聊天记录或文件聚合。

## 验证

```sh
go test -race ./...
npm run build
npx playwright install chromium
npm run test:e2e
```

如需复用已安装的 Chrome，可设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 为浏览器二进制绝对路径。

后端测试覆盖配对状态、过期、房间隔离、跨房间邀请、邀请单次使用、断线清理、未授权信令、代理头伪造和 WebSocket Origin 检查。端到端测试使用两个独立浏览器会话实际建立 WebRTC，校验下载文件字节一致、聊天送达，以及 WebSocket 帧中不包含聊天正文或文件名。

浏览器自动化在同一开发主机进行；真实网络访问云端服务、跨路由器及 iOS / Android 实机的兼容性仍需部署后验证。
