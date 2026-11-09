import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

async function device(browser: Browser, name: string, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1536, height: 1024 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  await context.addInitScript((name: string) => {
    localStorage.setItem("nearby.name", name);
    const Original = window.RTCPeerConnection;
    (window as any).__pcs = [];
    window.RTCPeerConnection = new Proxy(Original, {
      construct(target, args) {
        const pc = new target(...args);
        (window as any).__pcs.push(pc);
        return pc;
      },
    });
  }, name);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent: string[] = [];
  page.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (typeof frame.payload === "string") sent.push(frame.payload);
    }),
  );
  await page.goto("/");
  await expect(page.getByText("云端已连接", { exact: true })).toBeVisible();
  return { context, page, errors, sent, name };
}
type Device = Awaited<ReturnType<typeof device>>;
async function pair(a: Device, b: Device) {
  await a.page
    .getByRole("button", { name: new RegExp(b.name) })
    .first()
    .click();
  await a.page
    .getByRole("button", { name: "请求连接", exact: true })
    .first()
    .click();
  await expect(a.page.locator(".conversation-title")).toContainText(
    "等待对方确认",
  );
  await b.page.getByRole("button", { name: "接受", exact: true }).click();
  await expect(a.page.locator(".conversation-title")).toContainText(
    "直接连接 · 加密传输",
  );
  await expect(b.page.locator(".conversation-title")).toContainText(
    "直接连接 · 加密传输",
  );
}
async function saveBytes(page: Page, name: string) {
  const card = page.getByRole("article", { name: `文件 ${name}`, exact: true });
  await expect(card.getByRole("link", { name: "保存文件" })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await card.getByRole("link", { name: "保存文件" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(name);
  return readFile((await download.path())!);
}
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

test("真实双端直连：接收授权、聊天送达、文件字节一致及云端不接收正文", async ({
  browser,
}) => {
  const a = await device(browser, "我的 MacBook"),
    b = await device(browser, "小林的电脑");
  try {
    await a.page
      .getByRole("button", { name: /小林的电脑/ })
      .first()
      .click();
    await expect(
      a.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
    await pair(a, b);
    const secret = "端到端消息：你好，小林！<script>alert(1)</script>";
    await a.page.getByRole("textbox", { name: "消息内容" }).fill(secret);
    await a.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(b.page.locator(".bubble")).toHaveText(secret);
    await expect(a.page.getByText("已送达", { exact: true })).toBeVisible();
    await b.page
      .getByRole("textbox", { name: "消息内容" })
      .fill("收到了，直接把原文件发过来就好。");
    await b.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(a.page.locator(".bubble").last()).toContainText("收到了");
    const content = randomBytes(1024 * 1024 + 39),
      filename = "原图与资料 中文.zip";
    await a.page.getByLabel("选择发送文件").setInputFiles({
      name: filename,
      mimeType: "application/zip",
      buffer: content,
    });
    const incoming = b.page.getByRole("article", { name: `文件 ${filename}` });
    await expect(
      incoming.getByRole("button", { name: "接收文件" }),
    ).toBeVisible();
    await expect(incoming.getByRole("link", { name: "保存文件" })).toHaveCount(
      0,
    );
    await incoming.getByRole("button", { name: "接收文件" }).click();
    expect(hash(await saveBytes(b.page, filename))).toBe(hash(content));
    await expect(a.page.getByText("对方已接收", { exact: true })).toBeVisible();
    const configs = await a.page.evaluate(() =>
      (window as any).__pcs.map((pc: RTCPeerConnection) =>
        pc.getConfiguration(),
      ),
    );
    expect(configs).toHaveLength(1);
    expect(configs[0].iceServers).toEqual([]);
    const frames = [...a.sent, ...b.sent].map((frame) => JSON.parse(frame));
    expect(
      frames.every((frame) =>
        ["pair.request", "pair.respond", "signal"].includes(frame.type),
      ),
    ).toBeTruthy();
    expect(JSON.stringify(frames)).not.toContain(secret);
    expect(JSON.stringify(frames)).not.toContain(filename);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    await a.page.screenshot({
      path: "test-results/nearby-desktop.png",
      fullPage: true,
    });
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("共享目录仅配对后可见；按需下载、零字节、多文件排队、释放与取消共享", async ({
  browser,
}) => {
  const a = await device(browser, "共享电脑"),
    b = await device(browser, "下载电脑");
  try {
    const shared = Buffer.from("这是共享文件的真实内容。\n文件不会上传云端。");
    await a.page.getByLabel("选择共享文件").setInputFiles({
      name: "共享说明.md",
      mimeType: "text/markdown",
      buffer: shared,
    });
    await expect(
      a.page.getByRole("button", { name: "取消共享 共享说明.md" }),
    ).toBeVisible();
    await expect(
      b.page.getByRole("button", { name: "下载 共享说明.md" }),
    ).toHaveCount(0);
    await pair(a, b);
    await b.page.getByRole("button", { name: "下载 共享说明.md" }).click();
    expect(await saveBytes(b.page, "共享说明.md")).toEqual(shared);
    await b.page.getByRole("button", { name: "释放 共享说明.md" }).click();
    await expect(
      b.page.getByText("文件已从接收区释放", { exact: true }),
    ).toBeVisible();
    await a.page.getByRole("button", { name: "取消共享 共享说明.md" }).click();
    await expect(
      b.page.getByRole("button", { name: "下载 共享说明.md" }),
    ).toHaveCount(0);
    await a.page.getByLabel("选择发送文件").setInputFiles([
      { name: "空文件.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
      {
        name: "第二个文件.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("second"),
      },
    ]);
    await b.page
      .getByRole("article", { name: "文件 空文件.txt", exact: true })
      .getByRole("button", { name: "接收文件" })
      .click();
    expect((await saveBytes(b.page, "空文件.txt")).length).toBe(0);
    await b.page
      .getByRole("article", { name: "文件 第二个文件.txt", exact: true })
      .getByRole("button", { name: "接收文件" })
      .click();
    expect((await saveBytes(b.page, "第二个文件.txt")).toString()).toBe(
      "second",
    );
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("拒绝连接、文件拒收和排队取消；重新连接可继续聊天", async ({
  browser,
}) => {
  const a = await device(browser, "发送设备"),
    b = await device(browser, "接收设备");
  try {
    await a.page
      .getByRole("button", { name: /接收设备/ })
      .first()
      .click();
    await a.page
      .getByRole("button", { name: "请求连接", exact: true })
      .first()
      .click();
    await b.page.getByRole("button", { name: "拒绝 发送设备" }).click();
    await expect(a.page.locator(".conversation-title")).toContainText(
      "对方已拒绝",
    );
    await expect(
      a.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
    await pair(a, b);
    await a.page.getByLabel("选择发送文件").setInputFiles([
      { name: "拒收.txt", mimeType: "text/plain", buffer: Buffer.from("no") },
      {
        name: "取消排队.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("cancel"),
      },
    ]);
    await a.page
      .getByRole("article", { name: "文件 取消排队.txt", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await b.page
      .getByRole("article", { name: "文件 拒收.txt", exact: true })
      .getByRole("button", { name: "拒绝", exact: true })
      .click();
    await expect(
      a.page.getByText("对方拒绝接收", { exact: true }),
    ).toBeVisible();
    await a.page.getByRole("button", { name: "断开连接", exact: true }).click();
    await expect(
      b.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
    await pair(a, b);
    await a.page
      .getByRole("textbox", { name: "消息内容" })
      .fill("重新连接成功");
    await a.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(b.page.locator(".bubble")).toHaveText("重新连接成功");
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("手机布局：设备列表、配对、聊天、共享面板与断线状态", async ({
  browser,
}) => {
  const a = await device(browser, "桌面电脑"),
    b = await device(browser, "我的 iPhone", true);
  try {
    await expect(
      b.page.getByRole("heading", { name: "附近的设备" }),
    ).toBeVisible();
    await pair(a, b);
    await b.page
      .getByRole("textbox", { name: "消息内容" })
      .fill("来自手机的消息");
    await b.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(a.page.locator(".bubble")).toHaveText("来自手机的消息");
    await b.page.getByRole("button", { name: "打开共享文件" }).click();
    // The panel starts open; toggling once may close it.
    if (
      !(await b.page
        .getByRole("complementary", { name: "共享文件面板" })
        .isVisible())
    )
      await b.page.getByRole("button", { name: "打开共享文件" }).click();
    await expect(
      b.page.getByRole("complementary", { name: "共享文件面板" }),
    ).toBeVisible();
    await b.page
      .getByRole("button", { name: "关闭共享文件", exact: true })
      .click();
    await b.page.screenshot({
      path: "test-results/nearby-mobile.png",
      fullPage: true,
    });
    expect(
      await b.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await a.context.close();
    await expect(b.page.locator(".conversation-title")).toContainText("已离线");
    await expect(
      b.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
    expect(b.errors).toEqual([]);
  } finally {
    await b.context.close();
    await a.context.close();
  }
});

test("邀请链接完成发现，重复邀请明确提示失效；设备名称可以修改", async ({
  browser,
}) => {
  const a = await device(browser, "邀请方"),
    b = await device(browser, "受邀方");
  try {
    await a.page.getByRole("button", { name: "通过链接邀请" }).click();
    const input = a.page.getByRole("textbox", { name: "邀请链接" });
    await expect(input).toHaveValue(/#invite=[a-f0-9]{64}$/);
    const url = await input.inputValue();
    await b.page.goto(url);
    await expect(
      b.page.getByText("邀请已验证", { exact: false }),
    ).toBeVisible();
    await expect(
      b.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
    await b.page.goto(url);
    await expect(
      b.page.getByText("邀请已失效，请重新生成", { exact: true }),
    ).toBeVisible();
    await a.page.getByRole("button", { name: "关闭", exact: true }).click();
    await a.page.getByRole("button", { name: "修改设备名称" }).click();
    await a.page
      .getByRole("textbox", { name: "设备名称" })
      .fill("改名后的设备");
    await a.page.getByRole("button", { name: "保存名称" }).click();
    await expect(
      b.page.getByRole("button", { name: /改名后的设备/ }).first(),
    ).toBeVisible();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("真实协商超时明确提示失败，不使用 TURN；重试后可以直连", async ({
  browser,
}) => {
  const a = await device(browser, "失败重试电脑"),
    b = await device(browser, "等待连接电脑");
  let drop = true;
  try {
    await a.page.routeWebSocket("**/api/ws?*", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const event = JSON.parse(message.toString());
        if (!drop || event.type !== "signal") socket.send(message);
      });
    });
    // Re-register through the intercepted connection, then exercise the actual timeout path.
    await a.page.reload();
    await expect(a.page.getByText("云端已连接", { exact: true })).toBeVisible();
    await a.page
      .getByRole("button", { name: /等待连接电脑/ })
      .first()
      .click();
    await a.page
      .getByRole("button", { name: "请求连接", exact: true })
      .first()
      .click();
    await b.page.getByRole("button", { name: "接受", exact: true }).click();
    await expect(a.page.getByRole("alert")).toContainText("直连超时", {
      timeout: 25_000,
    });
    await expect(
      a.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
    const configs = await a.page.evaluate(() =>
      (window as any).__pcs.map((pc: RTCPeerConnection) =>
        pc.getConfiguration(),
      ),
    );
    expect(
      configs.every(
        (config: RTCConfiguration) => config.iceServers?.length === 0,
      ),
    ).toBeTruthy();
    drop = false;
    await a.page.getByRole("button", { name: "重试连接", exact: true }).click();
    // b has a prior selected conversation, so the request is shown inline.
    await b.page.getByRole("button", { name: "接受连接", exact: true }).click();
    await expect(a.page.locator(".conversation-title")).toContainText(
      "直接连接 · 加密传输",
    );
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("传输中取消不会污染后续文件；双方同时发送文件互不影响", async ({
  browser,
}) => {
  const a = await device(browser, "取消测试电脑"),
    b = await device(browser, "并行测试电脑");
  try {
    await pair(a, b);
    // Throttle binary reads so the user can cancel while a transfer is active.
    await a.page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function () {
        await new Promise((resolve) => setTimeout(resolve, 3));
        return original.call(this);
      };
    });
    await a.page.getByLabel("选择发送文件").setInputFiles([
      {
        name: "中途取消.bin",
        mimeType: "application/octet-stream",
        buffer: randomBytes(4 * 1024 * 1024),
      },
      {
        name: "取消后的文件.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("after cancellation"),
      },
    ]);
    const first = b.page.getByRole("article", {
      name: "文件 中途取消.bin",
      exact: true,
    });
    await first.getByRole("button", { name: "接收文件" }).click();
    await first.getByRole("button", { name: "取消", exact: true }).click();
    await expect(first).toContainText("已取消");
    await b.page
      .getByRole("article", { name: "文件 取消后的文件.txt", exact: true })
      .getByRole("button", { name: "接收文件" })
      .click();
    expect((await saveBytes(b.page, "取消后的文件.txt")).toString()).toBe(
      "after cancellation",
    );
    const left = randomBytes(64 * 1024 + 3),
      right = randomBytes(64 * 1024 + 7);
    await Promise.all([
      a.page.getByLabel("选择发送文件").setInputFiles({
        name: "A-to-B.bin",
        mimeType: "application/octet-stream",
        buffer: left,
      }),
      b.page.getByLabel("选择发送文件").setInputFiles({
        name: "B-to-A.bin",
        mimeType: "application/octet-stream",
        buffer: right,
      }),
    ]);
    await Promise.all([
      a.page
        .getByRole("article", { name: "文件 B-to-A.bin", exact: true })
        .getByRole("button", { name: "接收文件" })
        .click(),
      b.page
        .getByRole("article", { name: "文件 A-to-B.bin", exact: true })
        .getByRole("button", { name: "接收文件" })
        .click(),
    ]);
    expect(hash(await saveBytes(a.page, "B-to-A.bin"))).toBe(hash(right));
    expect(hash(await saveBytes(b.page, "A-to-B.bin"))).toBe(hash(left));
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("空房间、键盘改名、邀请二维码及窄屏可读性", async ({ browser }) => {
  const a = await device(browser, "空房间设备");
  try {
    await expect(
      a.page.getByRole("heading", { name: "让设备，在这里相遇。" }),
    ).toBeVisible();
    await a.page.screenshot({
      path: "test-results/nearby-welcome.png",
      fullPage: true,
    });
    await a.page
      .getByRole("button", { name: "邀请另一台设备", exact: true })
      .click();
    await expect(a.page.locator(".invite-qr svg")).toBeVisible();
    await a.page.screenshot({
      path: "test-results/nearby-invite.png",
      fullPage: true,
    });
    await a.page.keyboard.press("Escape");
    await expect(a.page.getByRole("dialog")).toHaveCount(0);
    await a.page.getByRole("button", { name: "修改设备名称" }).click();
    await a.page.getByRole("textbox", { name: "设备名称" }).fill("我的电脑");
    await a.page.keyboard.press("Enter");
    await expect(a.page.getByRole("dialog")).toHaveCount(0);
    await a.page.setViewportSize({ width: 360, height: 740 });
    expect(
      await a.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  } finally {
    await a.context.close();
  }
});

test("离线的无记录设备立即移除，新加入页面看不到已离线设备", async ({
  browser,
}) => {
  const a = await device(browser, "在线保留设备"),
    b = await device(browser, "即将离线设备");
  let c: Device | undefined;
  try {
    await expect(
      a.page
        .getByRole("group", { name: "在线设备" })
        .getByRole("button", { name: /即将离线设备/ }),
    ).toBeVisible();
    await b.context.close();
    await expect(
      a.page.getByRole("button", { name: /即将离线设备/ }),
    ).toHaveCount(0);
    await expect(a.page.getByRole("group", { name: "最近会话" })).toHaveCount(
      0,
    );
    c = await device(browser, "新加入设备");
    await expect(
      c.page
        .getByRole("group", { name: "在线设备" })
        .getByRole("button", { name: /在线保留设备/ }),
    ).toBeVisible();
    await expect(
      c.page.getByRole("button", { name: /即将离线设备/ }),
    ).toHaveCount(0);
  } finally {
    await a.context.close();
    await b.context.close();
    await c?.context.close();
  }
});

test("离线历史仅保留在本页最近会话，未保存文件仍可下载，新加入设备看不到历史", async ({
  browser,
}) => {
  const a = await device(browser, "历史保留设备"),
    b = await device(browser, "离线会话设备");
  let c: Device | undefined;
  try {
    await pair(a, b);
    await b.page
      .getByRole("textbox", { name: "消息内容" })
      .fill("这段记录只属于原会话");
    await b.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(a.page.locator(".bubble")).toHaveText("这段记录只属于原会话");
    const bytes = Buffer.from("离线后仍可保存的文件");
    await b.page
      .getByLabel("选择发送文件")
      .setInputFiles({
        name: "未保存.txt",
        mimeType: "text/plain",
        buffer: bytes,
      });
    await a.page
      .getByRole("article", { name: "文件 未保存.txt", exact: true })
      .getByRole("button", { name: "接收文件" })
      .click();
    await expect(a.page.getByRole("link", { name: "保存文件" })).toBeVisible();
    await b.context.close();
    await expect(
      a.page
        .getByRole("group", { name: "在线设备" })
        .getByRole("button", { name: /离线会话设备/ }),
    ).toHaveCount(0);
    await expect(
      a.page
        .getByRole("group", { name: "最近会话" })
        .getByRole("button", { name: /离线会话设备.*已离线/ }),
    ).toBeVisible();
    expect(await saveBytes(a.page, "未保存.txt")).toEqual(bytes);
    c = await device(browser, "新会话观察设备");
    await expect(
      c.page
        .getByRole("group", { name: "在线设备" })
        .getByRole("button", { name: /历史保留设备/ }),
    ).toBeVisible();
    await expect(
      c.page.getByRole("button", { name: /离线会话设备/ }),
    ).toHaveCount(0);
    await expect(c.page.getByRole("group", { name: "最近会话" })).toHaveCount(
      0,
    );
  } finally {
    await a.context.close();
    await b.context.close();
    await c?.context.close();
  }
});

test("云端重连后的在线快照重置离线状态，并保留本页会话记录", async ({
  browser,
}) => {
  const a = await device(browser, "重连测试设备"),
    b = await device(browser, "仍在线的设备");
  try {
    await pair(a, b);
    await a.page
      .getByRole("textbox", { name: "消息内容" })
      .fill("重连前的消息");
    await a.page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(b.page.locator(".bubble")).toHaveText("重连前的消息");
    const welcome = a.page.waitForEvent("websocket");
    await a.page.getByRole("button", { name: "刷新连接" }).click();
    await welcome;
    await expect(a.page.getByText("云端已连接", { exact: true })).toBeVisible();
    const row = a.page
      .getByRole("group", { name: "在线设备" })
      .getByRole("button", { name: /仍在线的设备/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("在线");
    await expect(row).not.toContainText("已离线");
    await expect(a.page.locator(".bubble")).toHaveText("重连前的消息");
    await expect(a.page.locator(".conversation-title")).toContainText("在线");
    await expect(
      a.page.getByRole("textbox", { name: "消息内容" }),
    ).toBeDisabled();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
