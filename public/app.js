const state = {
  token: localStorage.getItem("apiToken") || "",
  sessions: [],
  projects: [],
  selectedId: null,
  tab: "messages",
  eventSource: null,
};

const els = {
  statusDot: document.getElementById("status-dot"),
  banner: document.getElementById("banner"),
  tokenInput: document.getElementById("token-input"),
  tokenSave: document.getElementById("token-save"),
  addProjectBtn: document.getElementById("add-project"),
  projectsList: document.getElementById("projects-list"),
  newSessionBtn: document.getElementById("new-session"),
  sessionsList: document.getElementById("sessions-list"),
  detailPanel: document.getElementById("detail-panel"),
  modalOverlay: document.getElementById("modal-overlay"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalClose: document.getElementById("modal-close"),
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------- Modal ----------

function openModal(title, bodyHtml) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalOverlay.hidden = false;
}

function closeModal() {
  els.modalOverlay.hidden = true;
  els.modalBody.innerHTML = "";
}

els.modalClose.addEventListener("click", closeModal);
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});

// ---------- Health ----------

async function checkHealth() {
  try {
    const res = await fetch("/health");
    els.statusDot.className = "status-dot " + (res.ok ? "ok" : "bad");
  } catch {
    els.statusDot.className = "status-dot bad";
  }
}

// ---------- Projects ----------

async function refreshProjects() {
  try {
    state.projects = await api("/api/projects");
    renderProjects();
  } catch (err) {
    showBanner(err.message);
  }
}

function renderProjects() {
  els.projectsList.innerHTML = "";
  if (state.projects.length === 0) {
    els.projectsList.innerHTML = '<div class="hint">No projects yet — add one to start a session.</div>';
    return;
  }
  for (const p of state.projects) {
    const item = document.createElement("div");
    item.className = "project-item";
    item.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="repo" title="${escapeHtml(p.repoUrl)}">${escapeHtml(p.repoUrl)}${p.branch ? " @ " + escapeHtml(p.branch) : ""}</div>
      </div>
      ${p.hasToken ? '<span class="badge">PAT</span>' : ""}
      <button class="icon-btn" data-delete-project="${p.id}" title="Delete project">&times;</button>
    `;
    els.projectsList.appendChild(item);
  }

  for (const btn of els.projectsList.querySelectorAll("[data-delete-project]")) {
    btn.addEventListener("click", () => deleteProject(btn.dataset.deleteProject));
  }
}

async function deleteProject(id) {
  if (!confirm("Delete this project? Its cloned repo will be removed from disk.")) return;
  try {
    await api(`/api/projects/${id}`, { method: "DELETE" });
    await refreshProjects();
  } catch (err) {
    showBanner(err.message);
  }
}

function openAddProjectModal() {
  openModal(
    "Add project",
    `
    <div class="field">
      <label for="project-name">Name</label>
      <input id="project-name" type="text" placeholder="My project" />
    </div>
    <div class="field">
      <label for="project-repo">Repository URL</label>
      <input id="project-repo" type="text" placeholder="https://github.com/org/repo.git" />
    </div>
    <div class="field">
      <label for="project-branch">Branch (optional)</label>
      <input id="project-branch" type="text" placeholder="main" />
    </div>
    <div class="field">
      <label for="project-pat">GitHub Personal Access Token (optional, for private repos)</label>
      <input id="project-pat" type="password" placeholder="ghp_..." autocomplete="off" />
      <div class="field-hint">Stored on the server only, never shown again after saving.</div>
    </div>
    <div class="modal-actions">
      <button id="cancel-add-project">Cancel</button>
      <button id="submit-add-project" class="primary">Clone &amp; add</button>
    </div>
  `,
  );

  document.getElementById("cancel-add-project").addEventListener("click", closeModal);
  document.getElementById("submit-add-project").addEventListener("click", async () => {
    const name = document.getElementById("project-name").value.trim();
    const repoUrl = document.getElementById("project-repo").value.trim();
    const branch = document.getElementById("project-branch").value.trim();
    const pat = document.getElementById("project-pat").value.trim();

    if (!name || !repoUrl) {
      showBanner('"Name" and "Repository URL" are required.');
      return;
    }

    const submitBtn = document.getElementById("submit-add-project");
    submitBtn.disabled = true;
    submitBtn.textContent = "Cloning…";
    try {
      await api("/api/projects", {
        method: "POST",
        body: { name, repoUrl, branch: branch || undefined, pat: pat || undefined },
      });
      closeModal();
      await refreshProjects();
    } catch (err) {
      showBanner(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Clone & add";
    }
  });
}

els.addProjectBtn.addEventListener("click", openAddProjectModal);

// ---------- Metadata (agents / models) ----------

async function fetchAgents() {
  try {
    return await api("/api/meta/agents");
  } catch (err) {
    showBanner(err.message);
    return [];
  }
}

async function fetchProviders() {
  try {
    return await api("/api/meta/providers");
  } catch (err) {
    showBanner(err.message);
    return [];
  }
}

// ---------- Sessions ----------

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
    item.innerHTML = `<div class="title">${escapeHtml(s.title || shortId(s.id))}</div><div class="branch">${escapeHtml(s.projectName || "")} · ${escapeHtml(s.branch)}</div>`;
    item.addEventListener("click", () => selectSession(s.id));
    els.sessionsList.appendChild(item);
  }
}

async function openNewSessionModal() {
  if (state.projects.length === 0) {
    showBanner("Add a project first.");
    return;
  }

  openModal("New session", '<div class="hint">Loading models and agents…</div>');
  const [agents, providers] = await Promise.all([fetchAgents(), fetchProviders()]);

  const projectOptions = state.projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  const agentOptions = agents
    .map((a) => `<option value="${escapeHtml(a.name)}" title="${escapeHtml(a.description || "")}">${escapeHtml(a.name)}</option>`)
    .join("");
  const modelOptions = providers
    .map(
      (p) =>
        `<optgroup label="${escapeHtml(p.name)}">` +
        p.models.map((m) => `<option value="${p.id}::${m.id}">${escapeHtml(m.name)}</option>`).join("") +
        "</optgroup>",
    )
    .join("");

  openModal(
    "New session",
    `
    <div class="field">
      <label for="session-project">Project</label>
      <select id="session-project">${projectOptions}</select>
    </div>
    <div class="field">
      <label for="session-title">Title (optional)</label>
      <input id="session-title" type="text" placeholder="Fix login bug" />
    </div>
    <div class="field">
      <label for="session-agent">Agent</label>
      <select id="session-agent"><option value="">(default)</option>${agentOptions}</select>
    </div>
    <div class="field">
      <label for="session-model">Model</label>
      <select id="session-model"><option value="">(default)</option>${modelOptions}</select>
    </div>
    <div class="modal-actions">
      <button id="cancel-new-session">Cancel</button>
      <button id="submit-new-session" class="primary">Create</button>
    </div>
  `,
  );

  document.getElementById("cancel-new-session").addEventListener("click", closeModal);
  document.getElementById("submit-new-session").addEventListener("click", async () => {
    const projectId = document.getElementById("session-project").value;
    const title = document.getElementById("session-title").value.trim();
    const agent = document.getElementById("session-agent").value;
    const modelValue = document.getElementById("session-model").value;
    const model = modelValue ? { providerID: modelValue.split("::")[0], modelID: modelValue.split("::")[1] } : undefined;

    const submitBtn = document.getElementById("submit-new-session");
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";
    try {
      const created = await api("/api/sessions", {
        method: "POST",
        body: { projectId, title: title || undefined, agent: agent || undefined, model },
      });
      closeModal();
      await refreshSessions();
      selectSession(created.id);
    } catch (err) {
      showBanner(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Create";
    }
  });
}

els.newSessionBtn.addEventListener("click", openNewSessionModal);

function closeEventSource() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

function selectSession(id) {
  closeEventSource();
  state.selectedId = id;
  state.tab = "messages";
  renderSessions();
  renderDetail();
}

function renderDetail() {
  closeEventSource();
  const session = state.sessions.find((s) => s.id === state.selectedId);
  if (!session) {
    els.detailPanel.innerHTML = '<div class="empty-state">Select or create a session to get started.</div>';
    return;
  }

  els.detailPanel.innerHTML = `
    <div class="detail-head">
      <div class="path" title="${escapeHtml(session.path)}">${escapeHtml(session.projectName || "")} — ${escapeHtml(session.path)}</div>
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted)">
        <input type="checkbox" id="force-delete" /> force
      </label>
      <button id="delete-session" class="danger">Delete</button>
    </div>
    <div class="tabs">
      <button class="tab-btn" data-tab="messages">Messages</button>
      <button class="tab-btn" data-tab="console">Console</button>
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

  if (state.tab === "console") {
    container.innerHTML = '<div id="console-log" class="console-log"></div>';
    openConsole(session.id);
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

// ---------- Console (live event stream) ----------

function appendConsoleLine(className, icon, text) {
  const log = document.getElementById("console-log");
  if (!log) return;
  const line = document.createElement("div");
  line.className = "console-line " + className;
  line.innerHTML = `<span class="icon">${icon}</span><span>${escapeHtml(text)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function handleConsoleEvent(event) {
  const p = event.properties || {};
  switch (event.type) {
    case "message.part.updated": {
      const part = p.part;
      if (part?.type === "tool") {
        const status = part.state?.status;
        const title = part.state?.title || part.tool;
        if (status === "running") appendConsoleLine("tool", "🔧", `${part.tool} — ${title}…`);
        else if (status === "completed") appendConsoleLine("tool", "✅", `${part.tool} — ${title}`);
        else if (status === "error") appendConsoleLine("error", "❌", `${part.tool} failed: ${part.state?.error || ""}`);
      } else if (part?.type === "text" && part.text) {
        appendConsoleLine("text", "💬", part.text);
      }
      break;
    }
    case "file.edited":
      appendConsoleLine("file", "✏️", `edited ${p.file}`);
      break;
    case "session.status":
      appendConsoleLine("status", p.status?.type === "busy" ? "⏳" : "💤", `session ${p.status?.type}`);
      break;
    case "session.idle":
      appendConsoleLine("status", "✔️", "session idle");
      break;
    case "session.error":
      appendConsoleLine("error", "❌", p.error?.data?.message || p.error?.name || "session error");
      break;
    case "session.diff": {
      const files = (p.diff || []).length;
      if (files > 0) appendConsoleLine("file", "📝", `${files} file(s) changed`);
      break;
    }
    default:
      break;
  }
}

function openConsole(sessionId) {
  const url = `/api/sessions/${sessionId}/events?token=${encodeURIComponent(state.token)}`;
  const es = new EventSource(url);
  state.eventSource = es;

  es.onmessage = (msg) => {
    try {
      handleConsoleEvent(JSON.parse(msg.data));
    } catch {
      // ignore malformed/comment frames
    }
  };
  es.onerror = () => {
    appendConsoleLine("error", "⚠️", "Connection lost, retrying…");
  };
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
    list.innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
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
  refreshProjects();
  refreshSessions();
});

checkHealth();
setInterval(checkHealth, 15000);
if (state.token) {
  refreshProjects();
  refreshSessions();
}
