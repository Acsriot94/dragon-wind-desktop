"use strict";
/**
 * Preload — context bridge
 * Exposes a safe, typed API to the renderer process.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dw", {
  // Auth
  login:      (args)  => ipcRenderer.invoke("auth:login", args),
  logout:     ()      => ipcRenderer.invoke("auth:logout"),
  authStatus: ()      => ipcRenderer.invoke("auth:status"),

  // Folders
  getFolders: ()      => ipcRenderer.invoke("folders:list"),

  // Upload
  addFiles:   (args)  => ipcRenderer.invoke("upload:add", args),
  getQueue:   ()      => ipcRenderer.invoke("upload:queue"),
  cancel:     (id)    => ipcRenderer.invoke("upload:cancel", id),
  retry:      (id)    => ipcRenderer.invoke("upload:retry", id),

  // File picker
  pickFiles:  ()      => ipcRenderer.invoke("dialog:pickFiles"),

  // Settings
  getSettings: ()     => ipcRenderer.invoke("settings:get"),
  setSettings: (s)    => ipcRenderer.invoke("settings:set", s),

  // Window
  minimize:   ()      => ipcRenderer.send("window:minimize"),
  hide:       ()      => ipcRenderer.send("window:hide"),

  // Events from main → renderer
  onJobProgress: (cb) => ipcRenderer.on("job:progress", (_e, job) => cb(job)),
  onJobComplete: (cb) => ipcRenderer.on("job:complete", (_e, job) => cb(job)),
  onJobError:    (cb) => ipcRenderer.on("job:error",    (_e, job) => cb(job)),
  onAddFiles:    (cb) => ipcRenderer.on("menu:addFiles", (_e, paths) => cb(paths)),
  onNavSettings: (cb) => ipcRenderer.on("nav:settings",  () => cb()),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
