"use strict";
/**
 * Dragon Wind Desktop — Main Process
 *
 * Electron tray application for high-speed file uploads to Dragon Wind / S3.
 * Architecture mirrors MASV / Aspera: native process owns the transfer engine,
 * renderer handles UI. No browser UDP limitations.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require("electron");
const path = require("path");
const Store = require("electron-store");
const { TransferEngine } = require("./transfer-engine");
const { DragonWindClient } = require("./dw-client");

// ── Persistent config store ──────────────────────────────────────────────────
const store = new Store({
  schema: {
    serverUrl:  { type: "string", default: "" },
    authToken:  { type: "string", default: "" },
    username:   { type: "string", default: "" },
    workers:    { type: "number", default: 6 },
    chunkMb:    { type: "number", default: 16 },
  },
});

// ── Globals ──────────────────────────────────────────────────────────────────
let tray         = null;
let mainWindow   = null;
let engine       = null;
let dwClient     = null;
const isDev      = process.env.NODE_ENV === "development";

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // macOS: hide dock icon — we are a tray-only app
  if (process.platform === "darwin") app.dock.hide();

  createTray();
  createWindow();
  initEngine();
});

app.on("window-all-closed", (e) => {
  // Keep running in tray — don't quit on window close
  e.preventDefault();
});

app.on("before-quit", () => {
  engine?.shutdown();
});

// ── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, "../../assets/tray-icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Dragon Wind");
  updateTrayMenu();
  tray.on("double-click", showWindow);
}

function updateTrayMenu(stats = null) {
  const statusLine = stats
    ? `${stats.active} uploading  ·  ${stats.queued} queued  ·  ${formatSpeed(stats.speedBps)}`
    : "Idle";

  const menu = Menu.buildFromTemplate([
    { label: "Dragon Wind", enabled: false },
    { label: statusLine, enabled: false },
    { type: "separator" },
    { label: "Open Upload Window", click: showWindow },
    { label: "Add Files…", click: addFilesFromMenu },
    { type: "separator" },
    { label: "Settings", click: openSettings },
    { type: "separator" },
    { label: "Quit Dragon Wind", click: () => { app.exit(0); } },
  ]);
  tray.setContextMenu(menu);
}

// ── Main Window ───────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 500,
    show: false,
    frame: false,            // custom title bar in renderer
    resizable: true,
    backgroundColor: "#060812",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../../src/renderer/index.html"));

  if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("close", (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === "darwin") app.dock.show();
}

// ── Transfer Engine ───────────────────────────────────────────────────────────
function initEngine() {
  engine = new TransferEngine({
    workers:  store.get("workers"),
    chunkMb:  store.get("chunkMb"),
    onProgress: (job) => {
      mainWindow?.webContents.send("job:progress", job);
      updateTrayMenu(engine.getStats());
    },
    onComplete: (job) => {
      mainWindow?.webContents.send("job:complete", job);
      tray.displayBalloon?.({ title: "Upload complete", content: job.name, iconType: "info" });
      updateTrayMenu(engine.getStats());
    },
    onError: (job) => {
      mainWindow?.webContents.send("job:error", job);
      updateTrayMenu(engine.getStats());
    },
  });
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

// Auth
ipcMain.handle("auth:login", async (_e, { serverUrl, username, password }) => {
  dwClient = new DragonWindClient(serverUrl);
  const result = await dwClient.login(username, password);
  if (result.success) {
    store.set("serverUrl", serverUrl);
    store.set("authToken", result.token);
    store.set("username", username);
    dwClient.setToken(result.token);
  }
  return result;
});

ipcMain.handle("auth:logout", () => {
  store.set("authToken", "");
  store.set("username", "");
  dwClient = null;
  return { success: true };
});

ipcMain.handle("auth:status", () => {
  const token = store.get("authToken");
  const serverUrl = store.get("serverUrl");
  if (token && serverUrl) {
    if (!dwClient) {
      dwClient = new DragonWindClient(serverUrl);
      dwClient.setToken(token);
    }
    return { loggedIn: true, username: store.get("username"), serverUrl };
  }
  return { loggedIn: false };
});

// Folders
ipcMain.handle("folders:list", async () => {
  if (!dwClient) return { success: false, error: "Not logged in" };
  return dwClient.getFolders();
});

// Upload
ipcMain.handle("upload:add", async (_e, { files, prefix }) => {
  if (!dwClient) return { success: false, error: "Not logged in" };
  const jobs = [];
  for (const f of files) {
    const job = await engine.enqueue({ file: f, prefix, dwClient });
    jobs.push(job);
  }
  return { success: true, jobs };
});

ipcMain.handle("upload:queue", () => {
  return engine.getQueue();
});

ipcMain.handle("upload:cancel", (_e, jobId) => {
  engine.cancel(jobId);
  return { success: true };
});

ipcMain.handle("upload:retry", async (_e, jobId) => {
  if (!dwClient) return { success: false, error: "Not logged in" };
  return engine.retry(jobId, dwClient);
});

// File picker
ipcMain.handle("dialog:pickFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select files to upload",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Media Files", extensions: ["mxf","mp4","mov","avi","r3d","braw","arx","dpx","tif","tiff","wav","aif","aiff","xml","edl","aaf","fcpxml"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

// Settings
ipcMain.handle("settings:get", () => ({
  serverUrl: store.get("serverUrl"),
  workers:   store.get("workers"),
  chunkMb:   store.get("chunkMb"),
}));

ipcMain.handle("settings:set", (_e, settings) => {
  if (settings.workers !== undefined) {
    store.set("workers", settings.workers);
    engine?.setWorkers(settings.workers);
  }
  if (settings.chunkMb !== undefined) {
    store.set("chunkMb", settings.chunkMb);
    engine?.setChunkSize(settings.chunkMb);
  }
  return { success: true };
});

// Window controls
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:hide",     () => mainWindow?.hide());

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatSpeed(bps) {
  if (!bps || bps < 1024) return "0 KB/s";
  if (bps < 1024 * 1024) return (bps / 1024).toFixed(0) + " KB/s";
  return (bps / (1024 * 1024)).toFixed(1) + " MB/s";
}

async function addFilesFromMenu() {
  showWindow();
  const paths = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "All Files", extensions: ["*"] }],
  });
  if (!paths.canceled && paths.filePaths.length) {
    mainWindow.webContents.send("menu:addFiles", paths.filePaths);
  }
}

function openSettings() {
  showWindow();
  mainWindow.webContents.send("nav:settings");
}
