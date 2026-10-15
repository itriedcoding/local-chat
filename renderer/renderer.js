const $ = (id) => document.getElementById(id);

const state = {
  models: [],
  ollama: { ok: false, error: "", models: [] },
  lmstudio: { ok: false, error: "", models: [] },
  chats: [],
  settings: null,
  activeChatId: null,
  activeRequestId: null,
  generating: false,
  genStart: 0,
  genTokens: 0,
  hfResults: [],
  hfFiles: [],
  hfModelId: null,
  downloads: new Map(),
  attachments: []
};

const editor = {
  cm: null,
  root: null,
  tree: null,
  currentPath: null,
  dirty: false,
  loading: false,
  isArchive: false,
  expanded: new Set()
};
const loadedModes = new Set();

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 3600);
}
function fmtSize(b) {
  if (!b && b !== 0) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 ? 0 : 1) + " " + u[i];
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderMd(src) {
  let h = esc(src);
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _l, code) => `<pre><code>${code.replace(/^\n+|\n+$/g, "")}</code></pre>`);
  h = h.replace(/^#{1,3} (.*)$/gm, "<p><b>$1</b></p>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/^- (.*)$/gm, "• $1");
  h = h.replace(/\n/g, "<br>");
  return h;
}

function allModels() {
  return [...state.models, ...state.ollama.models, ...state.lmstudio.models];
}
function modelBackend(m) {
  return m.type === "ollama" ? "Ollama" : m.type === "lmstudio" ? "LM Studio" : "llama.cpp";
}
function activeModel() {
  const list = allModels();
  if (!list.length) return null;
  return list.find((m) => m.id === state.settings?.activeModelId) || list[0];
}
function activeChat() {
  return state.chats.find((c) => c.id === state.activeChatId) || null;
}

// ---------- views ----------
function showView(name) {
  for (const v of ["Chat", "Editor", "Models", "Discover", "Settings"]) $("view" + v).classList.add("hidden");
  $("view" + name).classList.remove("hidden");
  for (const [btn, v] of [["navChat", "Chat"], ["navEditor", "Editor"], ["navModels", "Models"], ["navDiscover", "Discover"], ["navSettings", "Settings"]])
    $(btn).classList.toggle("active", v === name);
  if (name === "Editor" && editor.cm) setTimeout(() => editor.cm.refresh(), 0);
}

// ---------- sidebar ----------
function renderModelSelect() {
  const sel = $("modelSelect");
  sel.innerHTML = "";
  const list = allModels();
  if (!list.length) {
    const o = document.createElement("option");
    o.textContent = "No models — add one";
    o.value = "";
    sel.appendChild(o);
    return;
  }
  const local = state.models;
  const oll = state.ollama.models;
  const lms = state.lmstudio.models;
  const mk = (arr, parent) => {
    for (const m of arr) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.name;
      if (state.settings && m.id === state.settings.activeModelId) o.selected = true;
      parent.appendChild(o);
    }
  };
  if (local.length) {
    const g = document.createElement("optgroup"); g.label = "LOCAL GGUF"; mk(local, g); sel.appendChild(g);
  }
  if (oll.length) {
    const g = document.createElement("optgroup"); g.label = "OLLAMA"; mk(oll, g); sel.appendChild(g);
  }
  if (lms.length) {
    const g = document.createElement("optgroup"); g.label = "LM STUDIO"; mk(lms, g); sel.appendChild(g);
  }
}
function renderModelStatus() {
  const el = $("modelStatus");
  const m = activeModel();
  if (!m) { el.textContent = "no model loaded"; el.classList.remove("ok"); return; }
  el.classList.add("ok");
  const tag = m.type === "ollama" ? "ollama" : m.type === "lmstudio" ? "lm studio" : "gguf";
  el.textContent = "● " + m.name + " · " + tag + (m.size ? " · " + fmtSize(m.size) : "");
}

// ---------- chats ----------
function renderChatList() {
  const wrap = $("chatList");
  wrap.innerHTML = "";
  for (const c of state.chats) {
    const d = document.createElement("div");
    d.className = "chat-item" + (c.id === state.activeChatId ? " active" : "");
    d.innerHTML =
      `<div style="min-width:0"><div class="t">${esc(c.title || "Untitled")}</div>` +
      `<div class="d">${esc((c.modelName || "") + " · " + (c.messages?.length || 0) + " msgs")}</div></div>`;
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = "Delete";
    x.onclick = async (e) => {
      e.stopPropagation();
      await window.api.deleteChat(c.id);
      state.chats = await window.api.listChats();
      if (state.activeChatId === c.id) {
        if (state.chats.length) state.activeChatId = state.chats[0].id;
        else await createChat(true);
      }
      renderAll();
    };
    d.appendChild(x);
    d.onclick = () => { state.activeChatId = c.id; renderAll(); };
    wrap.appendChild(d);
  }
}

function renderMessages(streamingText) {
  const box = $("messages");
  box.innerHTML = "";
  const chat = activeChat();
  $("chatTitle").textContent = chat ? (chat.title || "New chat") : "New chat";
  const all = allModels();
  if (!chat || !chat.messages.length) {
    const m = activeModel();
    box.innerHTML =
      `<div class="empty"><h2>LOCAL CHAT</h2>` +
      (all.length
        ? (m
          ? `<p>Chatting with <code>${esc(m.name)}</code> (${modelBackend(m)}). Everything runs on-device.</p><p>Type below to begin.</p>`
          : `<p>Select a model to begin.</p>`)
        : `<p>No models available.</p><p>Go to <code>MODELS</code> to add a <code>.gguf</code>, or connect Ollama or LM Studio.</p>`) +
      `</div>`;
    return;
  }
  chat.messages.forEach((msg, idx) => box.appendChild(messageEl(msg, idx, chat)));
  if (streamingText !== undefined) {
    const div = document.createElement("div");
    div.className = "msg assistant streaming";
    div.innerHTML = `<div class="who">MODEL</div><div class="bubble">${renderMd(streamingText) || "▌"}</div>`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function messageEl(msg, idx, chat) {
  const div = document.createElement("div");
  div.className = "msg " + (msg.role === "user" ? "user" : "assistant");
  div.innerHTML = `<div class="who">${msg.role === "user" ? "YOU" : "MODEL"}</div><div class="bubble">${renderMd(msg.content)}</div>`;
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    const mini = document.createElement("div");
    mini.className = "attach-mini";
    mini.innerHTML = msg.attachments.map((a) => `<span>${esc(a.name)}${a.size ? " · " + fmtSize(a.size) : ""}</span>`).join("");
    div.appendChild(mini);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const copy = document.createElement("button");
  copy.textContent = "COPY";
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(msg.content); toast("Copied."); }
    catch { toast("Copy failed."); }
  };
  actions.appendChild(copy);
  if (msg.role === "assistant" && idx === chat.messages.length - 1) {
    const re = document.createElement("button");
    re.textContent = "REGENERATE";
    re.onclick = regenerate;
    actions.appendChild(re);
  }
  div.appendChild(actions);
  return div;
}

function renderAll(streamingText) {
  renderModelSelect();
  renderModelStatus();
  renderChatList();
  renderModelList();
  renderOllamaList();
  renderLmStudioList();
  renderMessages(streamingText);
  renderDownloads();
  renderAttachments();
  $("btnSend").disabled = state.generating;
}

async function createChat(switchTo = true) {
  const m = activeModel();
  const chat = {
    id: "c_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    title: "New chat",
    modelId: m?.id || null,
    modelName: m?.name || "",
    messages: [],
    updatedAt: Date.now()
  };
  await window.api.saveChat(chat);
  state.chats.unshift(chat);
  if (switchTo) state.activeChatId = chat.id;
  return chat;
}

// ---------- models page ----------
function renderModelList() {
  const wrap = $("modelList");
  wrap.innerHTML = "";
  if (!state.models.length) {
    wrap.innerHTML = `<div class="empty"><h2>NO LOCAL MODELS</h2><p>Add a <code>.gguf</code> file, or download one from the <b>DISCOVER</b> tab.</p></div>`;
    return;
  }
  for (const m of state.models) {
    const card = document.createElement("div");
    card.className = "model-card" + (state.settings?.activeModelId === m.id ? " active" : "");
    const owned = m.source != null;
    card.innerHTML =
      `<div style="min-width:0"><div class="name">${esc(m.name)}</div>` +
      `<div class="path">${esc(m.path)}</div>` +
      `<div class="meta">${fmtSize(m.size)} · gguf${m.source ? " · from " + esc(m.source) : ""}</div></div>`;
    const acts = document.createElement("div");
    acts.className = "actions";
    acts.appendChild(mkBtn(state.settings?.activeModelId === m.id ? "ACTIVE" : "USE", state.settings?.activeModelId === m.id, async () => {
      state.settings = await window.api.setActiveModel(m.id); renderAll();
    }));
    acts.appendChild(mkBtn("REVEAL", false, () => window.api.revealModel(m.path)));
    if (owned) acts.appendChild(mkBtn("DELETE FILE", false, async () => {
      await window.api.deleteModelFile(m.id);
      state.models = await window.api.removeModel(m.id);
      state.settings = await window.api.getSettings();
      toast("Deleted file."); renderAll();
    }));
    acts.appendChild(mkBtn("REMOVE", false, async () => {
      state.models = await window.api.removeModel(m.id);
      state.settings = await window.api.getSettings();
      renderAll();
    }));
    card.appendChild(acts);
    wrap.appendChild(card);
  }
}
function mkBtn(text, primary, onClick) {
  const b = document.createElement("button");
  b.className = "btn small" + (primary ? " primary" : "");
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

function renderOllamaList() {
  const wrap = $("ollamaList");
  const hint = $("ollamaHint");
  wrap.innerHTML = "";
  if (!state.ollama.ok) {
    hint.innerHTML = `Could not reach Ollama at <code>${esc(state.settings?.ollamaUrl || "")}</code>. ` +
      `Install it from <code>ollama.com</code>, run <code>ollama serve</code>, then REFRESH.` +
      (state.ollama.error ? ` <span class="muted">(${esc(state.ollama.error)})</span>` : "");
    return;
  }
  if (!state.ollama.models.length) {
    hint.innerHTML = `Connected to Ollama, but no models are pulled. Run <code>ollama pull llama3.2</code>, then REFRESH.`;
    return;
  }
  hint.innerHTML = `Connected. ${state.ollama.models.length} model(s) available.`;
  for (const m of state.ollama.models) {
    const card = document.createElement("div");
    card.className = "model-card" + (state.settings?.activeModelId === m.id ? " active" : "");
    card.innerHTML =
      `<div style="min-width:0"><div class="name">${esc(m.name)} <span class="tag ollama">OLLAMA</span></div>` +
      `<div class="meta">${fmtSize(m.size)}${m.details?.parameter_size ? " · " + esc(m.details.parameter_size) : ""}${m.details?.quantization_level ? " · " + esc(m.details.quantization_level) : ""}</div></div>`;
    card.appendChild(mkBtn(state.settings?.activeModelId === m.id ? "ACTIVE" : "USE", state.settings?.activeModelId === m.id, async () => {
      state.settings = await window.api.setActiveModel(m.id); renderAll();
    }));
    wrap.appendChild(card);
  }
}

function renderLmStudioList() {
  const wrap = $("lmstudioList");
  const hint = $("lmstudioHint");
  wrap.innerHTML = "";
  if (!state.lmstudio.ok) {
    hint.innerHTML = `Could not reach LM Studio at <code>${esc(state.settings?.lmstudioUrl || "")}</code>. ` +
      `Open LM Studio, go to the <b>Developer</b> tab, start the local server, then REFRESH.` +
      (state.lmstudio.error ? ` <span class="muted">(${esc(state.lmstudio.error)})</span>` : "");
    return;
  }
  if (!state.lmstudio.models.length) {
    hint.innerHTML = `Connected to LM Studio, but no models are loaded. Load a model in LM Studio, then REFRESH.`;
    return;
  }
  hint.innerHTML = `Connected. ${state.lmstudio.models.length} model(s) available.`;
  for (const m of state.lmstudio.models) {
    const card = document.createElement("div");
    card.className = "model-card" + (state.settings?.activeModelId === m.id ? " active" : "");
    card.innerHTML =
      `<div style="min-width:0"><div class="name">${esc(m.name)} <span class="tag lmstudio">LM STUDIO</span></div>` +
      `<div class="meta">${fmtSize(m.size)}</div></div>`;
    card.appendChild(mkBtn(state.settings?.activeModelId === m.id ? "ACTIVE" : "USE", state.settings?.activeModelId === m.id, async () => {
      state.settings = await window.api.setActiveModel(m.id); renderAll();
    }));
    wrap.appendChild(card);
  }
}

// ---------- discover (hugging face) ----------
function renderHfResults() {
  const wrap = $("hfResults");
  wrap.innerHTML = "";
  if (!state.hfResults.length) return;
  for (const r of state.hfResults) {
    const card = document.createElement("div");
    card.className = "model-card" + (state.hfModelId === r.id ? " active" : "");
    card.innerHTML =
      `<div style="min-width:0"><div class="name">${esc(r.id)}</div>` +
      `<div class="meta">↓ ${Number(r.downloads).toLocaleString()} · ♥ ${r.likes}</div></div>`;
    card.appendChild(mkBtn("VIEW FILES", state.hfModelId === r.id, () => loadHfFiles(r.id)));
    wrap.appendChild(card);
  }
}
async function loadHfFiles(id) {
  state.hfModelId = id;
  $("hfFilesTitle").textContent = "FILES · " + id;
  $("hfFilesWrap").classList.remove("hidden");
  $("hfFiles").innerHTML = `<div class="muted">Loading…</div>`;
  renderHfResults();
  try {
    state.hfFiles = await window.api.hfFiles(id);
    renderHfFiles_();
  } catch (err) {
    $("hfFiles").innerHTML = `<div class="muted">Failed: ${esc(err.message || err)}</div>`;
  }
}
function renderHfFiles_() {
  const wrap = $("hfFiles");
  wrap.innerHTML = "";
  if (!state.hfFiles.length) { wrap.innerHTML = `<div class="muted">No .gguf files in this repo.</div>`; return; }
  for (const f of state.hfFiles) {
    const card = document.createElement("div");
    card.className = "model-card";
    card.innerHTML =
      `<div style="min-width:0"><div class="name">${esc(f.path)}</div><div class="meta">${fmtSize(f.size)}</div></div>`;
    card.appendChild(mkBtn("DOWNLOAD", true, () => startDownload(f)));
    wrap.appendChild(card);
  }
}
async function startDownload(f) {
  const downloadId = "d_" + Date.now().toString(36);
  const fileName = f.path.split("/").pop();
  state.downloads.set(downloadId, { name: fileName, received: 0, total: f.size, status: "downloading", downloadId });
  $("downloadsWrap").classList.remove("hidden");
  renderDownloads();
  try {
    const model = await window.api.hfDownload({ downloadId, modelId: state.hfModelId, filePath: f.path, fileName });
    state.models = await window.api.listModels();
    state.settings = await window.api.getSettings();
    if (!state.settings.activeModelId) state.settings = await window.api.setActiveModel(model.id);
    renderAll();
  } catch {
    // handled via hf:error
  }
  renderDownloads();
}
function renderDownloads() {
  const wrap = $("downloads");
  wrap.innerHTML = "";
  if (!state.downloads.size) { $("downloadsWrap").classList.add("hidden"); return; }
  for (const d of state.downloads.values()) {
    const card = document.createElement("div");
    card.className = "model-card";
    const pct = d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
    card.innerHTML =
      `<div style="min-width:0;flex:1"><div class="name">${esc(d.name)}</div>` +
      `<div class="meta">${d.status === "downloading" ? `${fmtSize(d.received)}${d.total ? " / " + fmtSize(d.total) : ""} · ${pct}%` : d.status}</div>` +
      `<div class="dl-track"><div class="dl-fill" style="width:${pct}%"></div></div></div>`;
    if (d.status === "downloading") {
      card.appendChild(mkBtn("CANCEL", false, () => window.api.hfCancel(d.downloadId)));
    }
    wrap.appendChild(card);
  }
}

// ---------- generation ----------
let streamBuf = "";
async function send() {
  if (state.generating) return;
  const text = $("input").value.trim();
  const atts = state.attachments.slice();
  if (!text && !atts.length) return;
  const m = activeModel();
  if (!m) { toast("Add or select a model first."); showView("Models"); return; }
  let chat = activeChat();
  if (!chat) chat = await createChat();
  chat.modelId = m.id;
  chat.modelName = m.name;
  const block = buildAttachmentBlock(atts);
  chat.messages.push({
    role: "user",
    content: text || "(attached files)",
    attachments: atts.map((a) => ({ name: a.name, kind: a.kind, size: a.size, ext: a.ext })),
    context: block ? block + text : text
  });
  if (chat.messages.length === 1) chat.title = (text || (atts[0] && atts[0].name) || "New chat").slice(0, 42);
  chat.updatedAt = Date.now();
  $("input").value = "";
  autoGrow();
  state.attachments = [];
  renderAttachments();
  await generate(chat);
}

async function regenerate() {
  if (state.generating) return;
  const chat = activeChat();
  if (!chat || !chat.messages.length) { toast("Nothing to regenerate."); return; }
  while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") chat.messages.pop();
  if (!chat.messages.length || chat.messages[chat.messages.length - 1].role !== "user") { toast("Nothing to regenerate."); return; }
  await generate(chat);
}

async function generate(chat) {
  const m = activeModel();
  if (!m) { toast("No model selected."); return; }
  await window.api.saveChat(chat);
  state.generating = true;
  state.activeRequestId = "r_" + Date.now().toString(36);
  streamBuf = "";
  state.genStart = Date.now();
  state.genTokens = 0;
  $("genBar").classList.remove("hidden");
  $("genLabel").textContent = "generating with " + m.name + "…";
  renderAll("");
  const last = chat.messages[chat.messages.length - 1];
  const history = chat.messages.slice(0, -1).map((x) => ({ role: x.role, content: x.context || x.content }));
  try {
    await window.api.sendChat({
      requestId: state.activeRequestId,
      chatId: chat.id,
      model: m,
      message: last.context || last.content,
      history
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (!/abort/i.test(msg)) {
      state.generating = false;
      $("genBar").classList.add("hidden");
      renderAll();
      toast("Inference failed: " + msg);
    }
  }
}

function wireStreaming() {
  window.api.onToken(({ requestId, token }) => {
    if (requestId !== state.activeRequestId) return;
    streamBuf += token;
    state.genTokens++;
    const secs = Math.max(0.001, (Date.now() - state.genStart) / 1000);
    $("genLabel").textContent = `generating… ${state.genTokens} tok · ${(state.genTokens / secs).toFixed(1)} tok/s`;
    renderMessages(streamBuf);
  });
  window.api.onDone(async ({ requestId, full }) => {
    if (requestId !== state.activeRequestId) return;
    const chat = activeChat();
    const text = full || streamBuf;
    if (chat && text) {
      chat.messages.push({ role: "assistant", content: text });
      chat.updatedAt = Date.now();
      await window.api.saveChat(chat);
      state.chats = await window.api.listChats();
    }
    finishGeneration();
  });
  window.api.onError(async ({ requestId, message }) => {
    if (requestId !== state.activeRequestId) return;
    const chat = activeChat();
    if (streamBuf && chat && message === "Generation stopped.") {
      chat.messages.push({ role: "assistant", content: streamBuf + "\n\n_[stopped]_" });
      chat.updatedAt = Date.now();
      await window.api.saveChat(chat);
      state.chats = await window.api.listChats();
    } else if (message !== "Generation stopped.") {
      toast(message);
    }
    finishGeneration();
  });
}
function finishGeneration() {
  state.generating = false;
  state.activeRequestId = null;
  streamBuf = "";
  $("genBar").classList.add("hidden");
  renderAll();
}

// ---------- settings ----------
function fillSettings() {
  const s = state.settings;
  $("sSystem").value = s.systemPrompt;
  $("sTemp").value = s.temperature; $("vTemp").textContent = s.temperature;
  $("sTopP").value = s.topP; $("vTopP").textContent = s.topP;
  $("sTopK").value = s.topK;
  $("sRep").value = s.repeatPenalty;
  $("sMax").value = s.maxTokens;
  $("sCtx").value = String(s.contextSize);
  $("sThreads").value = s.threads;
  $("sGpu").value = s.gpuLayers;
  $("sOllama").value = s.ollamaUrl || "";
  $("sLmStudio").value = s.lmstudioUrl || "";
}

async function refreshLmStudio(showToast) {
  const res = await window.api.listLmStudio();
  state.lmstudio = { ok: res.ok, error: res.error || "", models: res.models || [] };
  if (state.lmstudio.ok && state.settings) {
    const all = allModels();
    if (!all.find((m) => m.id === state.settings.activeModelId) && all.length) {
      state.settings = await window.api.setActiveModel(all[0].id);
    }
  }
  renderAll();
  if (showToast) toast(res.ok ? `LM Studio: ${res.models.length} model(s).` : "LM Studio unreachable.");
}

async function refreshOllama(showToast) {
  const res = await window.api.listOllama();
  state.ollama = { ok: res.ok, error: res.error || "", models: res.models || [] };
  if (state.ollama.ok && state.settings) {
    const all = allModels();
    if (!all.find((m) => m.id === state.settings.activeModelId) && all.length) {
      state.settings = await window.api.setActiveModel(all[0].id);
    }
  }
  renderAll();
  if (showToast) toast(res.ok ? `Ollama: ${res.models.length} model(s).` : "Ollama unreachable.");
}

function autoGrow() {
  const el = $("input");
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

// ---------- attachments ----------
const ATTACH_TEXT_CAP = 120000;
function attachKindLabel(kind) {
  return ({ text: "TXT", archive: "ZIP", binary: "BIN", rejected: "SKIP", error: "ERR" })[kind] || "FILE";
}
function renderAttachments() {
  const wrap = $("attachChips");
  wrap.innerHTML = "";
  if (!state.attachments.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const a of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "attach-chip" + (a.kind === "rejected" || a.kind === "error" ? " err" : "");
    chip.innerHTML =
      `<span class="k">${attachKindLabel(a.kind)}</span>` +
      `<span class="nm" title="${esc(a.name)}">${esc(a.name)}</span>` +
      `<span class="k">${fmtSize(a.size)}</span>`;
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = "Remove";
    x.onclick = () => { state.attachments = state.attachments.filter((k) => k.id !== a.id); renderAttachments(); };
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
}
function addAttachments(items) {
  if (!Array.isArray(items) || !items.length) return;
  let rejected = 0, added = 0;
  for (const it of items) {
    if (!it || !it.id) continue;
    if (it.kind === "rejected") { rejected++; continue; }
    if (state.attachments.find((k) => k.path === it.path)) continue;
    state.attachments.push(it);
    added++;
  }
  renderAttachments();
  if (rejected) toast("Skipped " + rejected + " audio/video file(s) — not supported.");
  else if (added) toast(added + " file(s) attached.");
}
async function pickAttachments() {
  try { addAttachments(await window.api.attachPick()); }
  catch (err) { toast("Attach failed: " + (err?.message || err)); }
}
function buildAttachmentBlock(list) {
  if (!list || !list.length) return "";
  let budget = ATTACH_TEXT_CAP;
  const parts = [];
  for (const a of list) {
    const head = `--- file: ${a.name} (${attachKindLabel(a.kind).toLowerCase()}, ${fmtSize(a.size)}) ---`;
    let body;
    if (a.kind === "text") {
      let t = a.text || "";
      if (t.length > budget) t = t.slice(0, Math.max(0, budget)) + "\n…[truncated]";
      budget -= Math.min(t.length, Math.max(0, budget));
      body = t;
    } else if (a.kind === "archive") {
      const lines = (a.entries || []).map((e) => `${String(e.size).padStart(9)}  ${e.name}`);
      body = `archive contains ${a.entryCount} entr${a.entryCount === 1 ? "y" : "ies"}` +
        (a.truncated ? " (showing first 400)" : "") + ":\n" + lines.join("\n");
    } else if (a.kind === "binary") {
      body = "binary file (contents not shown)";
    } else {
      body = a.error || "unavailable";
    }
    parts.push(head + "\n" + body);
  }
  return "Attached files:\n\n" + parts.join("\n\n") + "\n\n";
}

// ---------- modal / context menu ----------
function askModal(title, value) {
  return new Promise((resolve) => {
    const modal = $("modal");
    const input = $("modalInput");
    $("modalTitle").textContent = title;
    if (value === null) { input.classList.add("hidden"); }
    else { input.classList.remove("hidden"); input.value = value; }
    modal.classList.remove("hidden");
    setTimeout(() => { if (value !== null) { input.focus(); input.select(); } }, 0);
    const done = (val) => {
      modal.classList.add("hidden");
      $("modalOk").onclick = null;
      $("modalCancel").onclick = null;
      modal.onclick = null;
      input.onkeydown = null;
      resolve(val);
    };
    $("modalOk").onclick = () => done(value === null ? true : input.value.trim());
    $("modalCancel").onclick = () => done(value === null ? false : null);
    modal.onclick = (e) => { if (e.target === modal) done(value === null ? false : null); };
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(value === null ? true : input.value.trim()); }
      else if (e.key === "Escape") done(value === null ? false : null);
    };
  });
}
const askInput = (title, def = "") => askModal(title, def);
const askConfirm = (title) => askModal(title, null);

function showMenu(x, y, items) {
  const m = $("ctxMenu");
  m.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("div");
    b.className = "ctx-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.onclick = (e) => { e.stopPropagation(); hideMenu(); it.onClick(); };
    m.appendChild(b);
  }
  m.style.left = x + "px";
  m.style.top = y + "px";
  m.classList.remove("hidden");
}
function hideMenu() { $("ctxMenu").classList.add("hidden"); }

// ---------- code editor ----------
const MODE_DEPS = {
  htmlmixed: ["xml", "javascript", "css"],
  php: ["xml", "javascript", "css", "htmlmixed"],
  vue: ["xml", "javascript", "css", "htmlmixed"],
  markdown: ["xml"],
  gfm: ["xml", "markdown"],
  haml: ["ruby"],
  smartymixed: ["xml"],
  twig: ["xml"],
  jinja2: ["xml"],
  django: ["xml"],
  xquery: ["xml"]
};
function modeInfoFor(name) {
  if (!window.CodeMirror || !CodeMirror.findModeByFileName) return null;
  const base = String(name).replace(/^.*[\\/]/, "");
  const byFile = CodeMirror.findModeByFileName(base);
  if (byFile) return byFile;
  const dot = base.lastIndexOf(".");
  if (dot > -1) return CodeMirror.findModeByExtension(base.slice(dot + 1)) || null;
  return null;
}
function loadModeFolder(folder) {
  if (loadedModes.has(folder)) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "../node_modules/codemirror/mode/" + folder + "/" + folder + ".js";
    s.onload = () => { loadedModes.add(folder); resolve(); };
    s.onerror = () => { loadedModes.add(folder); resolve(); };
    document.body.appendChild(s);
  });
}
async function ensureMode(info) {
  if (!info) return null;
  const folder = info.mode;
  const deps = MODE_DEPS[folder];
  if (deps) for (const d of deps) await loadModeFolder(d);
  await loadModeFolder(folder);
  return info.mime || (info.mimes && info.mimes[0]) || null;
}

function initEditor() {
  if (editor.cm) return;
  editor.cm = CodeMirror.fromTextArea($("edArea"), {
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    lineWrapping: false,
    autoCloseBrackets: true,
    matchBrackets: true,
    styleActiveLine: true,
    foldGutter: true,
    gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
    extraKeys: {
      "Ctrl-S": () => saveEditorFile(),
      "Cmd-S": () => saveEditorFile(),
      "Ctrl-/": "toggleComment",
      "Cmd-/": "toggleComment",
      "Ctrl-F": "find",
      "Cmd-F": "find",
      "Ctrl-H": "replace",
      "Tab": (cm) => { if (cm.somethingSelected()) cm.indentSelection("add"); else cm.replaceSelection("  "); }
    }
  });
  editor.cm.on("change", () => { if (!editor.loading) { editor.dirty = true; updateEditorStatus(); } });
  editor.cm.on("cursorActivity", updateCursor);
}
function updateEditorStatus() {
  const rel = editor.currentPath && editor.root ? editor.currentPath.replace(editor.root, "").replace(/^[\\/]/, "") : "";
  $("edStatus").textContent = (editor.dirty ? "● unsaved · " : "") + (rel || "ready");
}
function updateCursor() {
  if (!editor.cm) { $("edCursor").textContent = ""; return; }
  const c = editor.cm.getCursor();
  $("edCursor").textContent = "Ln " + (c.line + 1) + ", Col " + (c.ch + 1);
}
function renderTreeNodes(nodes, container, depth) {
  for (const n of nodes) {
    const row = document.createElement("div");
    row.className = "tree-row" + (n.dir ? " dir" : "") + (n.path === editor.currentPath ? " active" : "");
    row.style.paddingLeft = (8 + depth * 13) + "px";
    if (n.dir) {
      const open = editor.expanded.has(n.path);
      row.innerHTML = `<span class="ic">${open ? "▾" : "▸"}</span><span class="nm">${esc(n.name)}</span>`;
      row.onclick = () => {
        if (editor.expanded.has(n.path)) editor.expanded.delete(n.path);
        else editor.expanded.add(n.path);
        renderTreeView();
      };
      row.oncontextmenu = (e) => { e.preventDefault(); dirMenu(e, n.path); };
      container.appendChild(row);
      if (open) renderTreeNodes(n.children || [], container, depth + 1);
    } else {
      row.innerHTML = `<span class="ic">·</span><span class="nm">${esc(n.name)}</span><span class="sz">${fmtSize(n.size)}</span>`;
      row.onclick = () => openEditorFile(n.path);
      row.oncontextmenu = (e) => { e.preventDefault(); fileMenu(e, n.path, n.name); };
      container.appendChild(row);
    }
  }
}
function renderTreeView() {
  const wrap = $("edTree");
  wrap.innerHTML = "";
  if (!editor.tree || !editor.tree.length) {
    wrap.innerHTML = `<div class="muted" style="padding:8px 12px">empty folder</div>`;
    return;
  }
  renderTreeNodes(editor.tree, wrap, 0);
}
function dirMenu(e, dirPath) {
  showMenu(e.clientX, e.clientY, [
    { label: "New File", onClick: () => createIn(dirPath, false) },
    { label: "New Folder", onClick: () => createIn(dirPath, true) },
    { label: "Rename", onClick: () => renameEntry(dirPath) },
    { label: "Delete", danger: true, onClick: () => deleteEntry(dirPath) },
    { label: "Reveal in Explorer", onClick: () => window.api.editorReveal(dirPath) }
  ]);
}
const ARCHIVE_RE = /\.(zip|jar|apk|epub|docx|xlsx|pptx|odt|ods|odp|war|aar|whl)$/i;
async function extractArchivePath(filePath) {
  try {
    const res = await window.api.editorExtract({ archivePath: filePath });
    editor.expanded.add(res.path.replace(/[\\/][^\\/]*$/, ""));
    await refreshTree();
    toast("Extracted " + res.files + " file(s).");
  } catch (err) { toast("Extract failed: " + (err?.message || err)); }
}
function fileMenu(e, filePath, name) {
  const items = [{ label: "Open", onClick: () => openEditorFile(filePath) }];
  if (ARCHIVE_RE.test(name)) items.push({ label: "Extract here", onClick: () => extractArchivePath(filePath) });
  items.push(
    { label: "Rename", onClick: () => renameEntry(filePath) },
    { label: "Delete", danger: true, onClick: () => deleteEntry(filePath) },
    { label: "Reveal in Explorer", onClick: () => window.api.editorReveal(filePath) }
  );
  showMenu(e.clientX, e.clientY, items);
}
async function openFolder() {
  try {
    const res = await window.api.editorOpenFolder();
    if (!res) return;
    editor.root = res.root;
    editor.expanded = new Set();
    $("edRootName").textContent = res.name;
    await refreshTree();
  } catch (err) { toast("Open folder failed: " + (err?.message || err)); }
}
async function refreshTree() {
  if (!editor.root) return;
  try {
    const res = await window.api.editorList();
    if (!res) return;
    editor.tree = res.tree;
    $("edRootName").textContent = res.name;
    renderTreeView();
  } catch (err) { toast("Refresh failed: " + (err?.message || err)); }
}
function showArchive(res) {
  editor.isArchive = true;
  editor.currentPath = res.path;
  editor.dirty = false;
  $("edWelcome").classList.add("hidden");
  $("edWrap").classList.add("hidden");
  $("edArchive").classList.remove("hidden");
  $("edFileLabel").textContent = res.name;
  $("edFileLabel").title = res.path;
  $("edSave").disabled = true;
  $("edExtract").disabled = false;
  $("edRename").disabled = false;
  $("edDelete").disabled = false;
  $("edReveal").disabled = false;
  $("edArchiveLabel").textContent = res.name;
  $("edArchiveMeta").textContent =
    `${res.entryCount} entr${res.entryCount === 1 ? "y" : "ies"} · ${fmtSize(res.size)}` +
    (res.truncated ? " · showing first 2000" : "");
  const list = $("edArchiveList");
  list.innerHTML = "";
  if (!res.entries.length) {
    list.innerHTML = `<div class="muted" style="padding:12px">empty archive</div>`;
  } else {
    for (const e of res.entries) {
      const row = document.createElement("div");
      row.className = "arc-row" + (e.dir ? " dir" : "");
      row.innerHTML = `<span class="nm" title="${esc(e.name)}">${esc(e.name)}${e.dir ? "/" : ""}</span>` +
        `<span class="sz">${e.dir ? "" : fmtSize(e.size)}</span>`;
      list.appendChild(row);
    }
  }
  $("edStatus").textContent = "archive · " + res.name;
  $("edCursor").textContent = "";
  renderTreeView();
}

async function openEditorFile(path) {
  try {
    const res = await window.api.editorRead(path);
    if (res.archive) {
      if (editor.dirty && editor.currentPath && editor.currentPath !== path) {
        const keep = await askConfirm("Discard unsaved changes?");
        if (!keep) return;
      }
      showArchive(res);
      return;
    }
    if (res.binary) { toast("Binary file · not editable as text."); return; }
    if (editor.dirty && editor.currentPath && editor.currentPath !== path) {
      const keep = await askConfirm("Discard unsaved changes?");
      if (!keep) return;
    }
    initEditor();
    editor.isArchive = false;
    $("edArchive").classList.add("hidden");
    editor.loading = true;
    editor.currentPath = path;
    const mime = await ensureMode(modeInfoFor(res.name));
    editor.cm.setOption("mode", mime || "null");
    editor.cm.setValue(res.content);
    editor.cm.clearHistory();
    editor.cm.setCursor({ line: 0, ch: 0 });
    editor.loading = false;
    editor.dirty = false;
    $("edWelcome").classList.add("hidden");
    $("edWrap").classList.remove("hidden");
    $("edFileLabel").textContent = res.name;
    $("edFileLabel").title = path;
    $("edSave").disabled = false;
    $("edExtract").disabled = true;
    $("edRename").disabled = false;
    $("edDelete").disabled = false;
    $("edReveal").disabled = false;
    setTimeout(() => editor.cm.refresh(), 0);
    updateEditorStatus();
    updateCursor();
    renderTreeView();
  } catch (err) { toast("Open failed: " + (err?.message || err)); }
}
function closeEditorFile() {
  editor.currentPath = null;
  editor.dirty = false;
  editor.isArchive = false;
  if (editor.cm) { editor.loading = true; editor.cm.setValue(""); editor.cm.clearHistory(); editor.loading = false; }
  $("edWrap").classList.add("hidden");
  $("edArchive").classList.add("hidden");
  $("edWelcome").classList.remove("hidden");
  $("edFileLabel").textContent = "no file open";
  $("edFileLabel").title = "";
  $("edSave").disabled = true;
  $("edExtract").disabled = true;
  $("edRename").disabled = true;
  $("edDelete").disabled = true;
  $("edReveal").disabled = true;
  updateEditorStatus();
  updateCursor();
  renderTreeView();
}

async function extractArchive() {
  if (!editor.isArchive || !editor.currentPath) { toast("Open an archive first."); return; }
  try {
    const res = await window.api.editorExtract({ archivePath: editor.currentPath });
    editor.expanded.add(res.path.replace(/[\\/][^\\/]*$/, ""));
    await refreshTree();
    toast("Extracted " + res.files + " file(s).");
  } catch (err) { toast("Extract failed: " + (err?.message || err)); }
}
async function saveEditorFile() {
  if (editor.isArchive) { toast("Archive files can't be saved as text."); return; }
  if (!editor.currentPath || !editor.cm) { toast("No file open."); return; }
  try {
    await window.api.editorWrite({ filePath: editor.currentPath, content: editor.cm.getValue() });
    editor.dirty = false;
    updateEditorStatus();
    toast("Saved " + editor.currentPath.replace(/^.*[\\/]/, ""));
  } catch (err) { toast("Save failed: " + (err?.message || err)); }
}
function currentDir() {
  if (editor.currentPath) return editor.currentPath.replace(/[\\/][^\\/]*$/, "");
  return editor.root;
}
async function createIn(dir, isDir) {
  if (!editor.root) { toast("Open a folder first."); return; }
  const name = await askInput(isDir ? "New folder name" : "New file name", "");
  if (!name) return;
  try {
    const res = await window.api.editorCreate({ dir: dir || editor.root, name, isDir });
    editor.expanded.add(dir || editor.root);
    await refreshTree();
    if (!isDir) await openEditorFile(res.path);
    toast((isDir ? "Created folder " : "Created ") + name);
  } catch (err) { toast("Create failed: " + (err?.message || err)); }
}
async function renameEntry(targetPath) {
  const oldName = targetPath.replace(/^.*[\\/]/, "");
  const name = await askInput("Rename", oldName);
  if (!name || name === oldName) return;
  try {
    const res = await window.api.editorRename({ targetPath, newName: name });
    if (editor.currentPath === targetPath) {
      editor.currentPath = res.path;
      $("edFileLabel").textContent = name;
      $("edFileLabel").title = res.path;
    }
    await refreshTree();
    updateEditorStatus();
  } catch (err) { toast("Rename failed: " + (err?.message || err)); }
}
async function deleteEntry(targetPath) {
  const name = targetPath.replace(/^.*[\\/]/, "");
  const ok = await askConfirm('Delete "' + name + '"? It goes to the Recycle Bin.');
  if (!ok) return;
  try {
    await window.api.editorDelete(targetPath);
    if (editor.currentPath === targetPath || (editor.currentPath || "").startsWith(targetPath + "\\") || (editor.currentPath || "").startsWith(targetPath + "/")) closeEditorFile();
    await refreshTree();
    toast("Deleted " + name);
  } catch (err) { toast("Delete failed: " + (err?.message || err)); }
}

// ---------- boot ----------
window.addEventListener("DOMContentLoaded", async () => {
  $("btnMin").onclick = () => window.api.minimize();
  $("btnMax").onclick = () => window.api.toggleMax();
  $("btnClose").onclick = () => window.api.close();

  $("navChat").onclick = () => showView("Chat");
  $("navEditor").onclick = () => showView("Editor");
  $("navModels").onclick = () => showView("Models");
  $("navDiscover").onclick = () => showView("Discover");
  $("navSettings").onclick = () => showView("Settings");

  // editor
  $("edOpenFolder").onclick = openFolder;
  $("edOpenFolder2").onclick = openFolder;
  $("edRefresh").onclick = refreshTree;
  $("edSave").onclick = saveEditorFile;
  $("edExtract").onclick = extractArchive;
  $("edNewFile").onclick = () => createIn(currentDir(), false);
  $("edNewFolder").onclick = () => createIn(currentDir(), true);
  $("edReveal").onclick = () => { if (editor.currentPath) window.api.editorReveal(editor.currentPath); };
  $("edRename").onclick = () => { if (editor.currentPath) renameEntry(editor.currentPath); };
  $("edDelete").onclick = () => { if (editor.currentPath) deleteEntry(editor.currentPath); };
  document.addEventListener("click", hideMenu);

  // attachments
  $("btnAttach").onclick = pickAttachments;
  let dragDepth = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    if ($("viewChat").classList.contains("hidden")) return;
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      $("dropHint").classList.remove("hidden");
      $("composerWrap").classList.add("dropping");
    }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) { $("dropHint").classList.add("hidden"); $("composerWrap").classList.remove("dropping"); }
  });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dropHint").classList.add("hidden");
    $("composerWrap").classList.remove("dropping");
    if ($("viewChat").classList.contains("hidden")) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    const paths = files.map((f) => { try { return window.api.filePath(f); } catch { return ""; } }).filter(Boolean);
    if (!paths.length) { toast("Could not read dropped file path."); return; }
    try { addAttachments(await window.api.attachDescribe(paths)); }
    catch (err) { toast("Attach failed: " + (err?.message || err)); }
  });

  $("btnNewChat").onclick = async () => { await createChat(); renderAll(); };
  $("modelSelect").onchange = async (e) => {
    state.settings = await window.api.setActiveModel(e.target.value);
    renderAll();
  };

  $("btnAddModel").onclick = async () => {
    const added = await window.api.addModel();
    if (!added) return;
    state.models = await window.api.listModels();
    state.settings = await window.api.getSettings();
    if (!state.settings.activeModelId) state.settings = await window.api.setActiveModel(added.id);
    toast("Added " + added.name);
    renderAll();
  };
  $("btnRefreshOllama").onclick = () => refreshOllama(true);
  $("btnRefreshLmStudio").onclick = () => refreshLmStudio(true);
  $("btnOpenDiscover").onclick = () => showView("Discover");

  $("btnHfSearch").onclick = doHfSearch;
  $("hfQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") doHfSearch(); });

  $("btnSend").onclick = send;
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $("input").addEventListener("input", autoGrow);
  $("btnStop").onclick = () => { if (state.activeRequestId) window.api.stopChat(state.activeRequestId); };
  $("btnRegen").onclick = regenerate;
  $("btnExportMd").onclick = () => doExport("md");
  $("btnExportJson").onclick = () => doExport("json");

  $("sTemp").oninput = (e) => ($("vTemp").textContent = e.target.value);
  $("sTopP").oninput = (e) => ($("vTopP").textContent = e.target.value);
  $("btnSaveSettings").onclick = async () => {
    state.settings = await window.api.saveSettings({
      systemPrompt: $("sSystem").value,
      temperature: Number($("sTemp").value),
      topP: Number($("sTopP").value),
      topK: Number($("sTopK").value),
      repeatPenalty: Number($("sRep").value),
      maxTokens: Number($("sMax").value),
      contextSize: Number($("sCtx").value),
      threads: Number($("sThreads").value),
      gpuLayers: Number($("sGpu").value),
      ollamaUrl: $("sOllama").value,
      lmstudioUrl: $("sLmStudio").value
    });
    $("settingsMsg").textContent = "Saved.";
    setTimeout(() => ($("settingsMsg").textContent = ""), 2000);
    renderAll();
    refreshOllama(false);
    refreshLmStudio(false);
  };
  $("btnResetSettings").onclick = async () => {
    state.settings = await window.api.saveSettings({
      systemPrompt: "You are a helpful assistant. Answer concisely.",
      temperature: 0.7, topP: 0.95, topK: 40, repeatPenalty: 1.1,
      maxTokens: 1024, contextSize: 4096, threads: 0, gpuLayers: 0,
      ollamaUrl: "http://127.0.0.1:11434", lmstudioUrl: "http://127.0.0.1:1234"
    });
    fillSettings();
    renderAll();
    refreshOllama(false);
    refreshLmStudio(false);
  };
  $("btnWipeChats").onclick = async () => {
    for (const c of [...state.chats]) await window.api.deleteChat(c.id);
    state.chats = [];
    await createChat(true);
    renderAll();
  };

  wireStreaming();
  window.api.onHfProgress(({ downloadId, received, total }) => {
    const d = state.downloads.get(downloadId);
    if (d) { d.received = received; d.total = total || d.total; renderDownloads(); }
  });
  window.api.onHfDone(({ downloadId }) => {
    const d = state.downloads.get(downloadId);
    if (d) { d.status = "done"; d.received = d.total; }
    toast("Download complete.");
    renderDownloads();
  });
  window.api.onHfError(({ downloadId, message }) => {
    const d = state.downloads.get(downloadId);
    if (d) d.status = message;
    toast(message);
    renderDownloads();
  });

  try {
    state.settings = await window.api.getSettings();
    state.models = await window.api.listModels();
    state.chats = await window.api.listChats();
    if (!state.chats.length) { const c = await createChat(false); state.chats = [c]; state.activeChatId = c.id; }
    else state.activeChatId = state.chats[0].id;
    fillSettings();
    renderAll();
    refreshOllama(false);
    refreshLmStudio(false);
  } catch (err) {
    toast("Boot failed: " + (err?.message || err));
  }
});

async function doHfSearch() {
  const q = $("hfQuery").value.trim();
  if (!q) return;
  $("hfResults").innerHTML = `<div class="muted">Searching…</div>`;
  $("hfFilesWrap").classList.add("hidden");
  try {
    state.hfResults = await window.api.hfSearch(q);
    if (!state.hfResults.length) $("hfResults").innerHTML = `<div class="muted">No GGUF repos found.</div>`;
    else renderHfResults();
  } catch (err) {
    $("hfResults").innerHTML = `<div class="muted">Search failed: ${esc(err.message || err)}</div>`;
  }
}

async function doExport(format) {
  const chat = activeChat();
  if (!chat || !chat.messages.length) { toast("Nothing to export."); return; }
  const p = await window.api.exportChat({ chat, format });
  if (p) toast("Exported to " + p);
}


