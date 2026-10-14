const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");

app.setName("Local Chat");
app.setAppUserModelId("com.localchat.desktop");

let mainWindow = null;

// ---------- storage ----------
function userFile(name) {
  return path.join(app.getPath("userData"), name);
}
function modelsDir() {
  const d = path.join(app.getPath("userData"), "models");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function readJson(name, fallback) {
  try {
    const p = userFile(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(name, data) {
  fs.writeFileSync(userFile(name), JSON.stringify(data, null, 2), "utf8");
}

const DEFAULT_SETTINGS = {
  systemPrompt: "You are a helpful assistant. Answer concisely.",
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  maxTokens: 1024,
  contextSize: 4096,
  threads: 0,
  gpuLayers: 0,
  ollamaUrl: "http://127.0.0.1:11434",
  activeModelId: null
};

// ---------- llama.cpp state ----------
let llamaInstance = null;
let loadedModelPath = null;
let loadedModel = null;
let loadedContext = null;
const localSessions = new Map(); // chatId -> { session, modelPath }
const abortControllers = new Map(); // requestId -> AbortController
const activeDownloads = new Map(); // id -> AbortController

async function getLlama() {
  if (llamaInstance) return llamaInstance;
  const { getLlama: _getLlama } = await import("node-llama-cpp");
  llamaInstance = await _getLlama();
  return llamaInstance;
}

function disposeSession(s) {
  try { s.session.dispose({ disposeSequence: true }); } catch {}
}

async function unloadModel() {
  for (const s of localSessions.values()) disposeSession(s);
  localSessions.clear();
  if (loadedContext) { try { await loadedContext.dispose(); } catch {} loadedContext = null; }
  if (loadedModel) { try { await loadedModel.dispose(); } catch {} loadedModel = null; }
  loadedModelPath = null;
}

async function ensureLocalModel(modelPath, settings) {
  if (loadedModelPath === modelPath && loadedModel && loadedContext) return;
  await unloadModel();
  const llama = await getLlama();
  const st = fs.statSync(modelPath); // throws if missing
  if (!st.isFile()) throw new Error("Model path is not a file");
  loadedModel = await llama.loadModel({
    modelPath,
    gpuLayers: Number(settings.gpuLayers) || 0
  });
  loadedContext = await loadedModel.createContext({
    contextSize: Number(settings.contextSize) || 4096,
    threads: Number(settings.threads) || 0
  });
  loadedModelPath = modelPath;
}

function toChatHistory(history, systemPrompt) {
  const chatHistory = [];
  if (systemPrompt) chatHistory.push({ type: "system", text: systemPrompt });
  for (const m of history) {
    if (m.role === "user") chatHistory.push({ type: "user", text: String(m.content || "") });
    else if (m.role === "assistant") chatHistory.push({ type: "model", response: [String(m.content || "")] });
  }
  return chatHistory;
}

async function getLocalSession(chatId, modelPath, settings, history) {
  await ensureLocalModel(modelPath, settings);
  const { LlamaChatSession } = await import("node-llama-cpp");
  let entry = localSessions.get(chatId);
  if (!entry || entry.modelPath !== modelPath) {
    if (entry) disposeSession(entry);
    const session = new LlamaChatSession({
      contextSequence: loadedContext.getSequence(),
      autoDisposeSequence: true,
      systemPrompt: settings.systemPrompt || undefined
    });
    entry = { session, modelPath };
    localSessions.set(chatId, entry);
  }
  try {
    entry.session.setChatHistory(toChatHistory(Array.isArray(history) ? history : [], settings.systemPrompt));
  } catch {
    try { entry.session.setChatHistory(toChatHistory([], settings.systemPrompt)); } catch {}
  }
  return entry.session;
}

// ---------- ollama ----------
function normalizeOllamaUrl(settings) {
  let u = String(settings.ollamaUrl || "http://127.0.0.1:11434").trim();
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  return u.replace(/\/+$/, "");
}
async function ollamaTags(settings) {
  const res = await fetch(normalizeOllamaUrl(settings) + "/api/tags", { method: "GET" });
  if (!res.ok) throw new Error("Ollama responded " + res.status);
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#000000",
    frame: false,
    titleBarStyle: "hidden",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------- IPC: window controls ----------
ipcMain.handle("app:minimize", () => mainWindow?.minimize());
ipcMain.handle("app:toggle-max", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
  mainWindow.maximize(); return true;
});
ipcMain.handle("app:close", () => mainWindow?.close());

// ---------- IPC: settings ----------
ipcMain.handle("settings:get", () => ({ ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) }));
ipcMain.handle("settings:save", async (_e, next) => {
  const prev = readJson("settings.json", DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...prev, ...next };
  for (const k of ["temperature", "topP", "topK", "repeatPenalty", "maxTokens", "contextSize", "threads", "gpuLayers"]) {
    merged[k] = Number(merged[k]);
  }
  writeJson("settings.json", merged);
  await unloadModel();
  for (const c of abortControllers.values()) { try { c.abort(); } catch {} }
  abortControllers.clear();
  return merged;
});

// ---------- IPC: local models ----------
ipcMain.handle("models:list", () => readJson("models.json", []));
ipcMain.handle("models:add", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Select GGUF model",
    filters: [{ name: "GGUF models", extensions: ["gguf"] }],
    properties: ["openFile"]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error("Not a file");
  if (path.extname(filePath).toLowerCase() !== ".gguf") throw new Error("File must have .gguf extension");
  const models = readJson("models.json", []);
  if (models.find((m) => m.path === filePath)) return models.find((m) => m.path === filePath);
  const entry = {
    id: "m_" + Date.now().toString(36),
    type: "local",
    name: path.basename(filePath, ".gguf"),
    path: filePath,
    size: stat.size,
    addedAt: Date.now()
  };
  models.push(entry);
  writeJson("models.json", models);
  return entry;
});
ipcMain.handle("models:remove", async (_e, id) => {
  let models = readJson("models.json", []);
  const target = models.find((m) => m.id === id);
  models = models.filter((m) => m.id !== id);
  writeJson("models.json", models);
  if (target && target.path === loadedModelPath) await unloadModel();
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  if (settings.activeModelId === id) {
    settings.activeModelId = models.length ? models[0].id : null;
    writeJson("settings.json", settings);
  }
  return models;
});
ipcMain.handle("models:delete-file", async (_e, id) => {
  const models = readJson("models.json", []);
  const target = models.find((m) => m.id === id);
  if (!target) return false;
  const dir = modelsDir();
  const resolved = path.resolve(target.path);
  if (resolved.startsWith(path.resolve(dir)) && fs.existsSync(resolved)) {
    try { fs.unlinkSync(resolved); } catch { return false; }
    return true;
  }
  return false;
});
ipcMain.handle("models:set-active", (_e, id) => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  settings.activeModelId = id;
  writeJson("settings.json", settings);
  return settings;
});
ipcMain.handle("models:reveal", (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

// ---------- IPC: ollama ----------
ipcMain.handle("ollama:list", async () => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  try {
    const tags = await ollamaTags(settings);
    return {
      ok: true,
      models: tags.map((t) => ({
        id: "o_" + Buffer.from(t.name).toString("hex"),
        type: "ollama",
        name: t.name,
        ollamaName: t.name,
        size: t.size || 0,
        details: t.details || {}
      }))
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), models: [] };
  }
});

// ---------- IPC: hugging face ----------
ipcMain.handle("hf:search", async (_e, query) => {
  const q = String(query || "").trim();
  if (!q) return [];
  const url = "https://huggingface.co/api/models?filter=gguf&search=" + encodeURIComponent(q) + "&limit=24&full=false&sort=downloads&direction=-1";
  const res = await fetch(url, { headers: { "User-Agent": "LocalChat" } });
  if (!res.ok) throw new Error("Hugging Face responded " + res.status);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((m) => ({
    id: m.id || m.modelId,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    updated: m.lastModified || null
  }));
});
ipcMain.handle("hf:files", async (_e, modelId) => {
  const url = "https://huggingface.co/api/models/" + modelId + "/tree/main?recursive=true";
  const res = await fetch(url, { headers: { "User-Agent": "LocalChat" } });
  if (!res.ok) throw new Error("Hugging Face responded " + res.status);
  const data = await res.json();
  const out = [];
  for (const f of Array.isArray(data) ? data : []) {
    if (f.type === "file" && /\.gguf$/i.test(f.path)) {
      out.push({ path: f.path, size: f.size || 0 });
    }
  }
  return out.sort((a, b) => a.size - b.size);
});
ipcMain.handle("hf:download", async (e, { downloadId, modelId, filePath, fileName }) => {
  const dest = path.join(modelsDir(), fileName || path.basename(filePath));
  const url = "https://huggingface.co/" + modelId + "/resolve/main/" + filePath;
  const controller = new AbortController();
  activeDownloads.set(downloadId, controller);
  const wc = e.sender;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "LocalChat" }, redirect: "follow" });
    if (!res.ok) throw new Error("Download failed: HTTP " + res.status);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const tmp = dest + ".part";
    const fd = fs.openSync(tmp, "w");
    let received = 0;
    let lastSent = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, Buffer.from(value));
      received += value.length;
      const now = Date.now();
      if (now - lastSent > 200) {
        lastSent = now;
        wc.send("hf:progress", { downloadId, received, total });
      }
    }
    fs.closeSync(fd);
    fs.renameSync(tmp, dest);
    const stat = fs.statSync(dest);
    const models = readJson("models.json", []);
    const entry = {
      id: "m_" + Date.now().toString(36),
      type: "local",
      name: path.basename(dest, ".gguf"),
      path: dest,
      size: stat.size,
      source: modelId,
      addedAt: Date.now()
    };
    models.push(entry);
    writeJson("models.json", models);
    activeDownloads.delete(downloadId);
    wc.send("hf:done", { downloadId, model: entry });
    return entry;
  } catch (err) {
    activeDownloads.delete(downloadId);
    try { const tmp = dest + ".part"; if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    const aborted = controller.signal.aborted;
    wc.send("hf:error", { downloadId, message: aborted ? "Canceled." : String(err?.message || err) });
    throw err;
  }
});
ipcMain.handle("hf:cancel", (_e, downloadId) => {
  const c = activeDownloads.get(downloadId);
  if (c) { try { c.abort(); } catch {} activeDownloads.delete(downloadId); return true; }
  return false;
});

// ---------- IPC: chats ----------
ipcMain.handle("chats:list", () => readJson("chats.json", []));
ipcMain.handle("chats:save", (_e, chat) => {
  const chats = readJson("chats.json", []);
  const i = chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) chats[i] = chat; else chats.unshift(chat);
  writeJson("chats.json", chats.slice(0, 300));
  return chat;
});
ipcMain.handle("chats:delete", (_e, id) => {
  const chats = readJson("chats.json", []).filter((c) => c.id !== id);
  writeJson("chats.json", chats);
  const s = localSessions.get(id);
  if (s) { disposeSession(s); localSessions.delete(id); }
  return true;
});
ipcMain.handle("chats:export", async (_e, { chat, format }) => {
  const safe = String(chat.title || "chat").replace(/[^a-z0-9\-_ ]/gi, "").trim() || "chat";
  const res = await dialog.showSaveDialog(mainWindow, {
    title: "Export conversation",
    defaultPath: safe + (format === "json" ? ".json" : ".md"),
    filters: format === "json"
      ? [{ name: "JSON", extensions: ["json"] }]
      : [{ name: "Markdown", extensions: ["md"] }]
  });
  if (res.canceled || !res.filePath) return null;
  let content;
  if (format === "json") {
    content = JSON.stringify(chat, null, 2);
  } else {
    const lines = ["# " + (chat.title || "Conversation"), ""];
    if (chat.modelName) lines.push("**Model:** " + chat.modelName, "");
    lines.push("---", "");
    for (const m of chat.messages || []) {
      lines.push(m.role === "user" ? "## You" : "## Assistant", "", m.content || "", "");
    }
    content = lines.join("\n");
  }
  fs.writeFileSync(res.filePath, content, "utf8");
  return res.filePath;
});

// ---------- IPC: chat generation ----------
ipcMain.handle("chat:send", async (e, { requestId, chatId, model, message, history }) => {
  const settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  if (!model || !model.type) throw new Error("No model selected.");
  const wc = e.sender;
  const controller = new AbortController();
  abortControllers.set(requestId, controller);
  wc.send("chat:started", { requestId });
  const maxTokens = Number(settings.maxTokens) > 0 ? Number(settings.maxTokens) : undefined;
  try {
    let full = "";
    if (model.type === "ollama") {
      full = await runOllama({ model, message, history, settings, controller, wc, requestId, maxTokens });
    } else {
      if (!model.path || !fs.existsSync(model.path)) throw new Error("Model file not found. Re-add the .gguf.");
      const session = await getLocalSession(chatId, model.path, settings, history);
      const response = await session.prompt(String(message), {
        signal: controller.signal,
        temperature: Number(settings.temperature),
        topK: Number(settings.topK),
        topP: Number(settings.topP),
        repeatPenalty: { penalty: Number(settings.repeatPenalty) },
        maxTokens,
        onTextChunk: (chunk) => { full += chunk; wc.send("chat:token", { requestId, token: chunk }); }
      });
      full = response || full;
    }
    abortControllers.delete(requestId);
    wc.send("chat:done", { requestId, full });
    return full;
  } catch (err) {
    abortControllers.delete(requestId);
    const aborted = controller.signal.aborted || err?.name === "AbortError";
    wc.send("chat:error", { requestId, message: aborted ? "Generation stopped." : String(err?.message || err) });
    throw err;
  }
});

async function runOllama({ model, message, history, settings, controller, wc, requestId, maxTokens }) {
  const messages = [];
  if (settings.systemPrompt) messages.push({ role: "system", content: settings.systemPrompt });
  for (const m of history || []) {
    if (m.role === "user" || m.role === "assistant") messages.push({ role: m.role, content: String(m.content || "") });
  }
  messages.push({ role: "user", content: String(message) });
  const body = {
    model: model.ollamaName || model.name,
    messages,
    stream: true,
    options: {
      temperature: Number(settings.temperature),
      top_p: Number(settings.topP),
      top_k: Number(settings.topK),
      repeat_penalty: Number(settings.repeatPenalty)
    }
  };
  if (maxTokens) body.options.num_predict = maxTokens;
  const res = await fetch(normalizeOllamaUrl(settings) + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal
  });
  if (!res.ok) throw new Error("Ollama responded " + res.status + (res.status === 404 ? " (model not found — pull it in Ollama)" : ""));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      if (obj.message && obj.message.content) {
        full += obj.message.content;
        wc.send("chat:token", { requestId, token: obj.message.content });
      }
      if (obj.error) throw new Error(obj.error);
    }
  }
  return full;
}

ipcMain.handle("chat:stop", (_e, requestId) => {
  const c = abortControllers.get(requestId);
  if (c) { try { c.abort(); } catch {} abortControllers.delete(requestId); return true; }
  return false;
});

// ---------- code editor ----------
let editorRoot = null;
const EDITOR_IGNORE = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "out", ".next", ".nuxt",
  ".cache", "__pycache__", ".venv", "venv", ".idea", ".DS_Store", "$RECYCLE.BIN"
]);

function insideRoot(p) {
  if (!editorRoot || !p) return false;
  const r = path.resolve(editorRoot);
  const t = path.resolve(p);
  return t === r || t.startsWith(r + path.sep);
}

function buildTree(dir, depth, budget) {
  if (depth > 9 || budget.n <= 0) return [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const dirs = [];
  const files = [];
  for (const e of entries) {
    if (budget.n <= 0) break;
    if (EDITOR_IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      budget.n--;
      dirs.push({ name: e.name, path: full, dir: true, children: buildTree(full, depth + 1, budget) });
    } else if (e.isFile()) {
      budget.n--;
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      files.push({ name: e.name, path: full, dir: false, size });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

ipcMain.handle("editor:open-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { title: "Open project folder", properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths.length) return null;
  editorRoot = res.filePaths[0];
  return { root: editorRoot, name: path.basename(editorRoot) || editorRoot };
});
ipcMain.handle("editor:list", () => {
  if (!editorRoot) return null;
  return { root: editorRoot, name: path.basename(editorRoot) || editorRoot, tree: buildTree(editorRoot, 0, { n: 20000 }) };
});
ipcMain.handle("editor:read", (_e, filePath) => {
  if (!insideRoot(filePath)) throw new Error("File is outside the open project folder.");
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error("Not a file.");
  const name = path.basename(filePath);
  if (st.size > 8 * 1024 * 1024) return { binary: true, path: filePath, name, size: st.size, content: "" };
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0)) return { binary: true, path: filePath, name, size: st.size, content: "" };
  return { binary: false, path: filePath, name, size: st.size, content: buf.toString("utf8") };
});
ipcMain.handle("editor:write", (_e, { filePath, content }) => {
  if (!insideRoot(filePath)) throw new Error("File is outside the open project folder.");
  fs.writeFileSync(filePath, String(content == null ? "" : content), "utf8");
  return { path: filePath, savedAt: Date.now() };
});
ipcMain.handle("editor:create", (_e, { dir, name, isDir }) => {
  if (!editorRoot) throw new Error("Open a folder first.");
  const base = dir && insideRoot(dir) ? dir : editorRoot;
  const clean = String(name || "").replace(/[\\/]/g, "").trim();
  if (!clean) throw new Error("Enter a name.");
  const target = path.join(base, clean);
  if (!insideRoot(target)) throw new Error("Invalid path.");
  if (fs.existsSync(target)) throw new Error("Already exists.");
  if (isDir) {
    fs.mkdirSync(target, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "", "utf8");
  }
  return { path: target, dir: !!isDir };
});
ipcMain.handle("editor:rename", (_e, { targetPath, newName }) => {
  if (!insideRoot(targetPath)) throw new Error("Outside the open project folder.");
  const clean = String(newName || "").replace(/[\\/]/g, "").trim();
  if (!clean) throw new Error("Enter a name.");
  const dest = path.join(path.dirname(targetPath), clean);
  if (!insideRoot(dest)) throw new Error("Invalid path.");
  if (fs.existsSync(dest)) throw new Error("Already exists.");
  fs.renameSync(targetPath, dest);
  return { path: dest };
});
ipcMain.handle("editor:delete", async (_e, targetPath) => {
  if (!insideRoot(targetPath)) throw new Error("Outside the open project folder.");
  if (path.resolve(targetPath) === path.resolve(editorRoot)) throw new Error("Cannot delete the project root.");
  await shell.trashItem(path.resolve(targetPath));
  return true;
});
ipcMain.handle("editor:reveal", (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(path.resolve(p));
});

// ---------- chat file attachments ----------
const AUDIO_VIDEO = new Set([
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "wma", "opus", "aiff", "aif", "alac", "mid", "midi", "amr", "ac3", "mka",
  "mp4", "m4v", "mkv", "avi", "mov", "qt", "wmv", "flv", "webm", "mpg", "mpeg", "3gp", "3g2", "ts", "m2ts", "vob", "ogv", "rm", "rmvb", "asf"
]);
const ZIP_CONTAINERS = new Set(["zip", "jar", "apk", "epub", "docx", "xlsx", "pptx", "odt", "ods", "odp", "war", "aar", "whl"]);

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8000);
  if (n === 0) return true;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 0) return false;
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  }
  return printable / n > 0.9;
}

function describeAttachment(fp) {
  const name = path.basename(fp);
  const ext = path.extname(fp).toLowerCase().replace(".", "");
  const item = { id: "a_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36), name, path: fp, ext, size: 0, kind: "binary" };
  let st;
  try { st = fs.statSync(fp); } catch (err) { item.kind = "error"; item.error = "Cannot read file."; return item; }
  item.size = st.size;
  if (!st.isFile()) { item.kind = "error"; item.error = "Not a file."; return item; }
  if (AUDIO_VIDEO.has(ext)) { item.kind = "rejected"; item.error = "Audio and video files are not supported."; return item; }
  try {
    if (ZIP_CONTAINERS.has(ext) && st.size <= 200 * 1024 * 1024) {
      try {
        const AdmZip = require("adm-zip");
        const zip = new AdmZip(fp);
        const entries = zip.getEntries();
        item.kind = "archive";
        item.entryCount = entries.length;
        item.entries = entries.slice(0, 400).map((e) => ({ name: e.entryName, size: e.header.size }));
        item.truncated = entries.length > 400;
        return item;
      } catch {
        // not a valid zip container — fall through to text/binary detection
      }
    }
    if (st.size <= 4 * 1024 * 1024) {
      const buf = fs.readFileSync(fp);
      if (isProbablyText(buf)) { item.kind = "text"; item.text = buf.toString("utf8"); return item; }
    }
    item.kind = "binary";
  } catch (err) {
    item.kind = "error";
    item.error = String(err?.message || err);
  }
  return item;
}

ipcMain.handle("attach:pick", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "Attach files",
    properties: ["openFile", "multiSelections"]
  });
  if (res.canceled || !res.filePaths.length) return [];
  return res.filePaths.map(describeAttachment);
});
ipcMain.handle("attach:describe", (_e, paths) => {
  if (!Array.isArray(paths)) return [];
  return paths.filter((p) => typeof p === "string" && p).map(describeAttachment);
});
