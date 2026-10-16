import { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { createLedger } from "../billing.mjs";
import { createKeyStore, checkKey } from "./key-store.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const setupFile = path.join(directory, "setup.html");
const setupURL = pathToFileURL(setupFile).href;
const official = {
  register: "https://platform.decart.ai",
  keys: "https://platform.decart.ai/api-keys",
  pricing: "https://docs.platform.decart.ai/getting-started/pricing",
};
let window, server, ledger, origin = "", key = "", store, saving = false, loadWarning = "";

// Desktop builds never inherit a developer's environment key or billing path.
delete process.env.DECART_API_KEY;
delete process.env.BILLING_DB_PATH;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { window?.restore(); window?.focus(); });
  app.whenReady().then(async () => {
    app.setName("TryOn Lab");
    store = createKeyStore(app.getPath("userData"), safeStorage);
    try { key = await store.read(); }
    catch { loadWarning = "之前保存的 Key 无法读取，请重新填写；账单记录仍保留。"; }
    process.env.FFPROBE_PATH = app.isPackaged
      ? path.join(process.resourcesPath, "ffprobe", "ffprobe.exe")
      : path.join(directory, "vendor", "ffprobe", "ffprobe.exe");

    window = new BrowserWindow({
      width: 1320, height: 900, minWidth: 850, minHeight: 650,
      title: "TryOn Lab", show: false, backgroundColor: "#f7f8fa",
      webPreferences: {
        preload: path.join(directory, "preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    const trustedWorkbench = (url) => Boolean(origin) && typeof url === "string" && url.startsWith(`${origin}/`);
    window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
      contents === window.webContents && permission === "media" &&
      (requestingOrigin === origin || trustedWorkbench(requestingOrigin)) && trustedWorkbench(contents.getURL()));
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(contents === window.webContents && permission === "media" &&
        trustedWorkbench(contents.getURL()) &&
        details.mediaTypes?.length > 0 && details.mediaTypes.every((type) => type === "video")));
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== setupURL && !trustedWorkbench(url)) event.preventDefault();
    });
    window.on("closed", () => { app.quit(); });
    window.once("ready-to-show", () => window.show());

    const fromSetup = (event) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== setupURL)
        throw new Error("此操作只能在应用配置页使用。");
    };
    const handle = (channel, operation) => ipcMain.handle(channel, async (event, ...args) => {
      try { fromSetup(event); return { ok: true, ...await operation(...args) }; }
      catch (error) {
        const message = error.message;
        return { ok: false, error: /^[\u4e00-\u9fff]/.test(message)
          ? message : "操作未完成，请重试或检查配置文件的访问权限。" };
      }
    });
    handle("setup:status", async () => ({ configured: Boolean(key), warning: loadWarning }));
    handle("setup:official", async (page) => {
      if (!Object.hasOwn(official, page)) throw new Error("链接不可用。");
      await shell.openExternal(official[page]); return {};
    });
    handle("setup:save", async (input) => {
      if (saving) throw new Error("正在保存，请稍等。");
      saving = true;
      try {
        const validated = await checkKey(input);
        key = await store.save(validated);
        loadWarning = "";
        await enterWorkbench();
        return {};
      } finally { saving = false; }
    });
    handle("setup:clear", async () => {
      if (saving) throw new Error("正在保存，请稍等。");
      await store.clear(); key = ""; loadWarning = "";
      await stopServer(); return { configured: false };
    });
    handle("setup:enter", async () => {
      if (!key) throw new Error("请先填写自己的 API Key。");
      await enterWorkbench(); return {};
    });
    const showSetup = async () => {
          if (trustedWorkbench(window.webContents.getURL())) {
            const result = await dialog.showMessageBox(window, { type: "question",
              message: "进入设置会关闭相机并清空未下载的结果；已提交的平台任务不保证取消。是否继续？",
              buttons: ["取消", "进入设置"], defaultId: 0, cancelId: 0 });
            if (result.response !== 1) return;
          }
          await window.loadFile(setupFile);
          await stopServer();
    };
    ipcMain.handle("desktop:settings", async (event) => {
      if (event.sender !== window.webContents || !trustedWorkbench(event.senderFrame?.url || ""))
        return { ok: false, error: "请从工作台进入设置。" };
      await showSetup(); return { ok: true };
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "应用", submenu: [
        { label: "API Key 设置", click: showSetup },
        { type: "separator" }, { role: "quit", label: "退出" },
      ] },
      { label: "编辑", submenu: [{ role: "undo", label: "撤销" }, { role: "redo", label: "重做" },
        { type: "separator" }, { role: "cut", label: "剪切" }, { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" }, { role: "selectAll", label: "全选" }] },
      { label: "帮助", submenu: Object.entries({ register: "注册 Decart 账号", keys: "创建 API Key", pricing: "官方价格" })
        .map(([page, label]) => ({ label, click: () => shell.openExternal(official[page]) })) },
    ]));
    try { if (key) await enterWorkbench(); else await window.loadFile(setupFile); }
    catch { await window.loadFile(setupFile); loadWarning = "工作台未能启动，请检查磁盘权限后重新进入。"; }
  }).catch((error) => {
    console.error("Desktop initialization failed:", error.code || error.name);
    dialog.showErrorBox("启动失败", "应用无法启动，请检查安装文件和当前用户目录的访问权限。");
    app.quit();
  });
}

async function stopServer() {
  if (server) {
    const previous = server; server = null; origin = "";
    previous.closeAllConnections();
    await new Promise((resolve) => previous.close(resolve));
  }
  ledger?.close(); ledger = null;
}

async function enterWorkbench() {
  await stopServer();
  ledger = createLedger(path.join(app.getPath("userData"), "billing.sqlite"));
  const session = randomBytes(32).toString("hex");
  server = createApp({ apiKey: key, ledger, port: 0, desktopSession: session });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  await window.webContents.session.cookies.set({ url: origin, name: "tryon_session",
    value: session, httpOnly: true, sameSite: "strict", path: "/" });
  await window.loadURL(`${origin}/#studio`);
}

app.on("before-quit", () => { server?.closeAllConnections(); server?.close(); ledger?.close(); ledger = null; });
