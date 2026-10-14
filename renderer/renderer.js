const $ = (id) => document.getElementById(id);

const state = {
  models: [],
  ollama: { ok: false, error: "", models: [] },
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
  downloads: new Map()
};

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
  return [...state.models, ...state.ollama.models];
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
  for (const v of ["Chat", "Models", "Discover", "Settings"]) $("view" + v).classList.add("hidden");
  $("view" + name).classList.remove("hidden");
  for (const [btn, v] of [["navChat", "Chat"], ["navModels", "Models"], ["navDiscover", "Discover"], ["navSettings", "Settings"]])
    $(btn).classList.toggle("active", v === name);
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
}
function renderModelStatus() {
  const el = $("modelStatus");
  const m = activeModel();
  if (!m) { el.textContent = "no model loaded"; el.classList.remove("ok"); return; }
  el.classList.add("ok");
  const tag = m.type === "ollama" ? "ollama" : "gguf";
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
      `<div class="empty"><h2>HACKERGPT</h2>` +
      (all.length
        ? (m
          ? `<p>Chatting with <code>${esc(m.name)}</code> (${m.type === "ollama" ? "Ollama" : "llama.cpp"}). Everything runs on-device.</p><p>Type below to begin.</p>`
          : `<p>Select a model to begin.</p>`)
        : `<p>No models available.</p><p>Go to <code>MODELS</code> to add a <code>.gguf</code>, or connect Ollama.</p>`) +
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
  renderMessages(streamingText);
  renderDownloads();
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
  if (!text) return;
  const m = activeModel();
  if (!m) { toast("Add or select a model first."); showView("Models"); return; }
  let chat = activeChat();
  if (!chat) chat = await createChat();
  chat.modelId = m.id;
  chat.modelName = m.name;
  chat.messages.push({ role: "user", content: text });
  if (chat.messages.length === 1) chat.title = text.slice(0, 42);
  chat.updatedAt = Date.now();
  $("input").value = "";
  autoGrow();
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
  const history = chat.messages.slice(0, -1).map((x) => ({ role: x.role, content: x.content }));
  try {
    await window.api.sendChat({
      requestId: state.activeRequestId,
      chatId: chat.id,
      model: m,
      message: last.content,
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

// ---------- boot ----------
window.addEventListener("DOMContentLoaded", async () => {
  $("btnMin").onclick = () => window.api.minimize();
  $("btnMax").onclick = () => window.api.toggleMax();
  $("btnClose").onclick = () => window.api.close();

  $("navChat").onclick = () => showView("Chat");
  $("navModels").onclick = () => showView("Models");
  $("navDiscover").onclick = () => showView("Discover");
  $("navSettings").onclick = () => showView("Settings");

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
      ollamaUrl: $("sOllama").value
    });
    $("settingsMsg").textContent = "Saved.";
    setTimeout(() => ($("settingsMsg").textContent = ""), 2000);
    renderAll();
  };
  $("btnResetSettings").onclick = async () => {
    state.settings = await window.api.saveSettings({
      systemPrompt: "You are a helpful assistant. Answer concisely.",
      temperature: 0.7, topP: 0.95, topK: 40, repeatPenalty: 1.1,
      maxTokens: 1024, contextSize: 4096, threads: 0, gpuLayers: 0,
      ollamaUrl: "http://127.0.0.1:11434"
    });
    fillSettings();
    renderAll();
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
