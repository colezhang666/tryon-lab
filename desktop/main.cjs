const { app, dialog } = require("electron");

// Initialize Electron before loading the ESM backend and its native SQLite module.
app.whenReady().then(() => import("./main.mjs")).catch((error) => {
  console.error("Desktop modules could not load:", error.code || error.name);
  dialog.showErrorBox("启动失败", "应用文件无法加载，请重新安装后重试。");
  app.quit();
});
