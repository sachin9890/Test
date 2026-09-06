const state = {
  token: localStorage.getItem("apiToken") || "",
  sessions: [],
  projects: [],
  selectedId: null,
  tab: "task",
  eventSource: null,
  taskFlows: new Map(), // sessionId -> { step, taskText, planText, resultText, resultError }
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
  state.tab = "task";
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
      <button class="tab-btn" data-tab="task">Task</button>
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
      state.taskFlows.delete(session.id);
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

  if (state.tab === "task") {
    renderTaskTab(session);
    return;
  }

  if (state.tab === "console") {
    container.innerHTML = '<div id="console-log" class="console-log"></div>';
    openConsole(session.id, "console-log");
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

function appendConsoleLine(containerId, className, icon, text) {
  const log = document.getElementById(containerId);
  if (!log) return;
  const line = document.createElement("div");
  line.className = "console-line " + className;
  line.innerHTML = `<span class="icon">${icon}</span><span>${escapeHtml(text)}</span>`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function handleConsoleEvent(containerId, event) {
  const p = event.properties || {};
  switch (event.type) {
    case "message.part.updated": {
      const part = p.part;
      if (part?.type === "tool") {
        const status = part.state?.status;
        const title = part.state?.title || part.tool;
        if (status === "running") appendConsoleLine(containerId, "tool", "🔧", `${part.tool} — ${title}…`);
        else if (status === "completed") appendConsoleLine(containerId, "tool", "✅", `${part.tool} — ${title}`);
        else if (status === "error")
          appendConsoleLine(containerId, "error", "❌", `${part.tool} failed: ${part.state?.error || ""}`);
      } else if (part?.type === "text" && part.text) {
        appendConsoleLine(containerId, "text", "💬", part.text);
      }
      break;
    }
    case "file.edited":
      appendConsoleLine(containerId, "file", "✏️", `edited ${p.file}`);
      break;
    case "session.status":
      appendConsoleLine(containerId, "status", p.status?.type === "busy" ? "⏳" : "💤", `session ${p.status?.type}`);
      break;
    case "session.idle":
      appendConsoleLine(containerId, "status", "✔️", "session idle");
      break;
    case "session.error":
      appendConsoleLine(containerId, "error", "❌", p.error?.data?.message || p.error?.name || "session error");
      break;
    case "session.diff": {
      const files = (p.diff || []).length;
      if (files > 0) appendConsoleLine(containerId, "file", "📝", `${files} file(s) changed`);
      break;
    }
    default:
      break;
  }
}

function openConsole(sessionId, containerId) {
  const url = `/api/sessions/${sessionId}/events?token=${encodeURIComponent(state.token)}`;
  const es = new EventSource(url);
  state.eventSource = es;

  es.onmessage = (msg) => {
    try {
      handleConsoleEvent(containerId, JSON.parse(msg.data));
    } catch {
      // ignore malformed/comment frames
    }
  };
  es.onerror = () => {
    appendConsoleLine(containerId, "error", "⚠️", "Connection lost, retrying…");
  };
}

// ---------- Task workflow: describe -> plan -> accept/reject -> implement ----------

function getTaskFlow(sessionId) {
  if (!state.taskFlows.has(sessionId)) {
    state.taskFlows.set(sessionId, { step: "input", taskText: "", planText: "", resultText: "", resultError: null });
  }
  return state.taskFlows.get(sessionId);
}

const TASK_STEPS = [
  { key: "input", label: "1 · Describe" },
  { key: "plan", label: "2 · Review plan" },
  { key: "implementing", label: "3 · Implement" },
  { key: "done", label: "4 · Done" },
];

function renderStepIndicator(step) {
  const normalized = step === "planning" ? "input-done" : step;
  const currentIndex = normalized === "input-done" ? 0 : TASK_STEPS.findIndex((s) => s.key === normalized);
  return `<div class="step-indicator">${TASK_STEPS.map((s, i) => {
    const cls = i === currentIndex && normalized !== "input-done" ? "current" : i <= currentIndex ? "done" : "";
    return `<div class="step ${cls}"><span class="step-dot"></span>${s.label}</div>`;
  }).join("")}</div>`;
}

function inlineFormat(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
}

// Minimal markdown-ish renderer for OpenCode's plan/reply text: headings, lists, code
// fences, bold/italic/inline-code. Input is already HTML-escaped before this runs.
function renderMarkdownLite(text) {
  const lines = escapeHtml(text || "").split("\n");
  let html = "";
  let listType = null;
  let inCode = false;
  let codeBuf = [];

  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html += `<pre class="plan-code"><code>${codeBuf.join("\n")}</code></pre>`;
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      html += `<div class="plan-heading">${inlineFormat(heading[2])}</div>`;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${inlineFormat(bullet[1])}</li>`;
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${inlineFormat(numbered[1])}</li>`;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    html += `<p>${inlineFormat(line)}</p>`;
  }
  closeList();
  if (inCode && codeBuf.length) html += `<pre class="plan-code"><code>${codeBuf.join("\n")}</code></pre>`;
  return html || "<p><em>(empty)</em></p>";
}

function renderTaskTab(session) {
  const container = document.getElementById("tab-content");
  const flow = getTaskFlow(session.id);

  container.innerHTML = `<div class="task-flow">${renderStepIndicator(flow.step)}<div id="task-step-body"></div></div>`;
  const body = document.getElementById("task-step-body");

  if (flow.step === "input") {
    body.innerHTML = `
      <div class="task-card">
        <h3>What do you want done?</h3>
        <p class="hint">OpenCode proposes a read-only plan first — nothing changes until you accept it.</p>
        <textarea id="task-input" rows="5" placeholder="e.g. Add input validation to the signup form and cover it with tests">${escapeHtml(flow.taskText)}</textarea>
        <div class="task-actions">
          <button id="generate-plan-btn" class="primary">Generate plan →</button>
        </div>
      </div>
    `;
    document.getElementById("generate-plan-btn").addEventListener("click", () => {
      const text = document.getElementById("task-input").value.trim();
      if (!text) {
        showBanner("Describe what you want done first.");
        return;
      }
      flow.taskText = text;
      generatePlan(session, flow);
    });
    return;
  }

  if (flow.step === "planning") {
    body.innerHTML = `
      <div class="task-card task-loading">
        <div class="spinner"></div>
        <p>Thinking through a plan…</p>
        <p class="hint">“${escapeHtml(flow.taskText)}”</p>
      </div>
    `;
    return;
  }

  if (flow.step === "plan") {
    body.innerHTML = `
      <div class="task-card">
        <h3>Proposed plan</h3>
        <div class="plan-content">${renderMarkdownLite(flow.planText)}</div>
        <div class="task-actions">
          <button id="reject-plan-btn" class="danger">✕ Reject</button>
          <button id="accept-plan-btn" class="primary">✓ Accept &amp; implement</button>
        </div>
      </div>
    `;
    document.getElementById("reject-plan-btn").addEventListener("click", () => {
      flow.step = "input";
      renderTaskTab(session);
    });
    document.getElementById("accept-plan-btn").addEventListener("click", () => implementPlan(session, flow));
    return;
  }

  if (flow.step === "implementing") {
    body.innerHTML = `
      <div class="task-card task-loading">
        <div class="spinner"></div>
        <p>Implementing the plan…</p>
      </div>
      <div id="task-console-log" class="console-log embedded"></div>
    `;
    openConsole(session.id, "task-console-log");
    return;
  }

  if (flow.step === "done") {
    body.innerHTML = `
      <div class="task-card">
        <h3>${flow.resultError ? "⚠️ Finished with an error" : "✅ Done"}</h3>
        <div class="plan-content">${renderMarkdownLite(flow.resultError || flow.resultText)}</div>
        <div class="task-actions">
          <button id="view-diff-btn">View diff</button>
          <button id="new-task-btn" class="primary">Start another task</button>
        </div>
      </div>
    `;
    document.getElementById("view-diff-btn").addEventListener("click", () => {
      state.tab = "diff";
      renderDetail();
    });
    document.getElementById("new-task-btn").addEventListener("click", () => {
      state.taskFlows.set(session.id, { step: "input", taskText: "", planText: "", resultText: "", resultError: null });
      renderTaskTab(session);
    });
  }
}

async function generatePlan(session, flow) {
  flow.step = "planning";
  renderTaskTab(session);
  try {
    // Always plan with OpenCode's built-in read-only "plan" agent, regardless of the
    // session's own default agent, so proposing a plan never edits files.
    const result = await api(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      body: { text: flow.taskText, agent: "plan" },
    });
    if (result.message?.error) {
      showBanner(result.message.error.data?.message || result.message.error.name || "Planning failed");
      flow.step = "input";
    } else {
      flow.planText = result.reply || "(no plan text returned)";
      flow.step = "plan";
    }
  } catch (err) {
    showBanner(err.message);
    flow.step = "input";
  }
  renderTaskTab(session);
}

async function implementPlan(session, flow) {
  flow.step = "implementing";
  renderTaskTab(session);
  // If the session's own default agent is itself the read-only "plan" agent, force
  // "build" for the implementation step so accepting a plan can actually edit files.
  const implementAgent = session.agent && session.agent !== "plan" ? session.agent : "build";
  try {
    const result = await api(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      body: { text: "Proceed and implement the plan you just proposed.", agent: implementAgent },
    });
    closeEventSource();
    if (result.message?.error) {
      flow.resultError = result.message.error.data?.message || result.message.error.name || "Implementation failed";
      flow.resultText = "";
    } else {
      flow.resultText = result.reply || "(no reply text)";
      flow.resultError = null;
    }
    flow.step = "done";
  } catch (err) {
    closeEventSource();
    showBanner(err.message);
    flow.step = "plan";
  }
  renderTaskTab(session);
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
