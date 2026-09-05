const state = {
  token: localStorage.getItem("apiToken") || "",
  sessions: [],
  selectedId: null,
  tab: "messages",
};

const els = {
  statusDot: document.getElementById("status-dot"),
  banner: document.getElementById("banner"),
  tokenInput: document.getElementById("token-input"),
  tokenSave: document.getElementById("token-save"),
  newTitle: document.getElementById("new-title"),
  newSessionBtn: document.getElementById("new-session"),
  refreshBtn: document.getElementById("refresh-sessions"),
  sessionsList: document.getElementById("sessions-list"),
  detailPanel: document.getElementById("detail-panel"),
};

els.tokenInput.value = state.token;

let bannerTimeout;
function showBanner(message) {
  els.banner.textContent = message;
  els.banner.hidden = false;
  clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    els.banner.hidden = true;
  }, 6000);
}

async function api(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (data && data.error) || (typeof data === "string" && data) || res.statusText;
    throw new Error(message);
  }
  return data;
}

function shortId(id) {
  return id.slice(0, 8);
}

async function checkHealth() {
  try {
    const res = await fetch("/health");
    els.statusDot.className = "status-dot " + (res.ok ? "ok" : "bad");
  } catch {
    els.statusDot.className = "status-dot bad";
  }
}

async function refreshSessions() {
  try {
    state.sessions = await api("/api/sessions");
    renderSessions();
  } catch (err) {
    showBanner(err.message);
  }
}

function renderSessions() {
  els.sessionsList.innerHTML = "";
  if (state.sessions.length === 0) {
    els.sessionsList.innerHTML = '<div class="empty-state">No sessions yet.</div>';
    return;
  }
  for (const s of state.sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === state.selectedId ? " active" : "");
    item.innerHTML = `<div class="title">${shortId(s.id)}</div><div class="branch">${s.branch}</div>`;
    item.addEventListener("click", () => selectSession(s.id));
    els.sessionsList.appendChild(item);
  }
}

function selectSession(id) {
  state.selectedId = id;
  state.tab = "messages";
  renderSessions();
  renderDetail();
}

function renderDetail() {
  const session = state.sessions.find((s) => s.id === state.selectedId);
  if (!session) {
    els.detailPanel.innerHTML = '<div class="empty-state">Select or create a session to get started.</div>';
    return;
  }

  els.detailPanel.innerHTML = `
    <div class="detail-head">
      <div class="path" title="${session.path}">${session.path}</div>
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted)">
        <input type="checkbox" id="force-delete" /> force
      </label>
      <button id="delete-session" class="danger">Delete</button>
    </div>
    <div class="tabs">
      <button class="tab-btn" data-tab="messages">Messages</button>
      <button class="tab-btn" data-tab="status">Status</button>
      <button class="tab-btn" data-tab="diff">Diff</button>
    </div>
    <div id="tab-content" class="tab-content"></div>
  `;

  for (const btn of els.detailPanel.querySelectorAll(".tab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === state.tab);
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      renderDetail();
    });
  }

  document.getElementById("delete-session").addEventListener("click", async () => {
    if (!confirm("Delete this session and its worktree?")) return;
    const force = document.getElementById("force-delete").checked;
    try {
      await api(`/api/sessions/${session.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      state.selectedId = null;
      await refreshSessions();
      renderDetail();
    } catch (err) {
      showBanner(err.message);
    }
  });

  loadTab(session);
}

async function loadTab(session) {
  const container = document.getElementById("tab-content");

  if (state.tab === "messages") {
    container.innerHTML = `
      <div id="messages-list" class="messages-list"><div class="empty-state">Loading…</div></div>
      <div class="composer">
        <textarea id="prompt-input" placeholder="Ask OpenCode to do something… (Cmd/Ctrl+Enter to send)"></textarea>
        <button id="send-prompt" class="primary">Send</button>
      </div>
    `;
    document.getElementById("send-prompt").addEventListener("click", () => sendPrompt(session.id));
    document.getElementById("prompt-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) sendPrompt(session.id);
    });
    await loadMessages(session.id);
    return;
  }

  if (state.tab === "status") {
    container.innerHTML = '<pre class="code-view">Loading…</pre>';
    const pre = container.querySelector("pre");
    try {
      const data = await api(`/api/sessions/${session.id}/status`);
      pre.textContent = data.status.trim() || "Working tree clean.";
    } catch (err) {
      pre.textContent = "Error: " + err.message;
    }
    return;
  }

  if (state.tab === "diff") {
    container.innerHTML = '<pre class="code-view">Loading…</pre>';
    const pre = container.querySelector("pre");
    try {
      const diff = await api(`/api/sessions/${session.id}/diff`);
      pre.textContent = diff.trim() || "No changes yet.";
    } catch (err) {
      pre.textContent = "Error: " + err.message;
    }
  }
}

async function loadMessages(sessionId) {
  const list = document.getElementById("messages-list");
  try {
    const messages = await api(`/api/sessions/${sessionId}/messages`);
    list.innerHTML = "";
    if (messages.length === 0) {
      list.innerHTML = '<div class="empty-state">No messages yet — send one below.</div>';
      return;
    }
    for (const m of messages) list.appendChild(renderMessage(m));
    list.scrollTop = list.scrollHeight;
  } catch (err) {
    list.innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
  }
}

function renderMessage(m) {
  const div = document.createElement("div");
  const text = (m.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  if (m.info.role === "assistant" && m.info.error) {
    div.className = "message error";
    div.textContent = m.info.error.data?.message || m.info.error.name || "Error";
  } else {
    div.className = "message " + m.info.role;
    div.textContent = text || "(no text content)";
  }
  return div;
}

async function sendPrompt(sessionId) {
  const input = document.getElementById("prompt-input");
  const text = input.value.trim();
  if (!text) return;

  const sendBtn = document.getElementById("send-prompt");
  const list = document.getElementById("messages-list");
  sendBtn.disabled = true;
  input.disabled = true;

  if (list.querySelector(".empty-state")) list.innerHTML = "";
  const userBubble = document.createElement("div");
  userBubble.className = "message user";
  userBubble.textContent = text;
  list.appendChild(userBubble);
  list.scrollTop = list.scrollHeight;
  input.value = "";

  try {
    const result = await api(`/api/sessions/${sessionId}/messages`, { method: "POST", body: { text } });
    const reply = document.createElement("div");
    if (result.message?.error) {
      reply.className = "message error";
      reply.textContent = result.message.error.data?.message || result.message.error.name || "Error";
    } else {
      reply.className = "message assistant";
      reply.textContent = result.reply || "(no text reply)";
    }
    list.appendChild(reply);
    list.scrollTop = list.scrollHeight;
  } catch (err) {
    showBanner(err.message);
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

els.tokenSave.addEventListener("click", () => {
  state.token = els.tokenInput.value.trim();
  localStorage.setItem("apiToken", state.token);
  refreshSessions();
});

els.refreshBtn.addEventListener("click", refreshSessions);

els.newSessionBtn.addEventListener("click", async () => {
  els.newSessionBtn.disabled = true;
  try {
    const title = els.newTitle.value.trim();
    const created = await api("/api/sessions", { method: "POST", body: title ? { title } : {} });
    els.newTitle.value = "";
    await refreshSessions();
    selectSession(created.id);
  } catch (err) {
    showBanner(err.message);
  } finally {
    els.newSessionBtn.disabled = false;
  }
});

checkHealth();
setInterval(checkHealth, 15000);
if (state.token) refreshSessions();
