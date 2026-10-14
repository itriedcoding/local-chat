const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  minimize: () => ipcRenderer.invoke("app:minimize"),
  toggleMax: () => ipcRenderer.invoke("app:toggle-max"),
  close: () => ipcRenderer.invoke("app:close"),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (s) => ipcRenderer.invoke("settings:save", s),

  listModels: () => ipcRenderer.invoke("models:list"),
  addModel: () => ipcRenderer.invoke("models:add"),
  removeModel: (id) => ipcRenderer.invoke("models:remove", id),
  deleteModelFile: (id) => ipcRenderer.invoke("models:delete-file", id),
  setActiveModel: (id) => ipcRenderer.invoke("models:set-active", id),
  revealModel: (p) => ipcRenderer.invoke("models:reveal", p),

  listOllama: () => ipcRenderer.invoke("ollama:list"),

  hfSearch: (q) => ipcRenderer.invoke("hf:search", q),
  hfFiles: (id) => ipcRenderer.invoke("hf:files", id),
  hfDownload: (payload) => ipcRenderer.invoke("hf:download", payload),
  hfCancel: (id) => ipcRenderer.invoke("hf:cancel", id),

  listChats: () => ipcRenderer.invoke("chats:list"),
  saveChat: (c) => ipcRenderer.invoke("chats:save", c),
  deleteChat: (id) => ipcRenderer.invoke("chats:delete", id),
  exportChat: (payload) => ipcRenderer.invoke("chats:export", payload),

  sendChat: (payload) => ipcRenderer.invoke("chat:send", payload),
  stopChat: (requestId) => ipcRenderer.invoke("chat:stop", requestId),

  onStarted: (cb) => ipcRenderer.on("chat:started", (_e, d) => cb(d)),
  onToken: (cb) => ipcRenderer.on("chat:token", (_e, d) => cb(d)),
  onDone: (cb) => ipcRenderer.on("chat:done", (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on("chat:error", (_e, d) => cb(d)),

  onHfProgress: (cb) => ipcRenderer.on("hf:progress", (_e, d) => cb(d)),
  onHfDone: (cb) => ipcRenderer.on("hf:done", (_e, d) => cb(d)),
  onHfError: (cb) => ipcRenderer.on("hf:error", (_e, d) => cb(d))
});
