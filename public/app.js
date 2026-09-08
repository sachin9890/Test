const state = {
  token: localStorage.getItem("apiToken") || "",
  sessions: [],
  projects: [],
  selectedId: null,
  tab: "task",
  // Kept per-session (not one global connection) so a session's live console keeps
  // streaming in the background while the user is looking at a different session —
  // switching away and back must not lose activity that happened while away.
  eventSources: new Map(), // sessionId -> EventSource
  consoleLines: new Map(), // sessionId -> ordered [{key, className, icon, text}] (full detail history)
  sessionStatus: new Map(), // sessionId -> {icon, text} short status, shown in the sidebar
  taskFlows: new Map(), // sessionId -> { step, taskText, planText, resultText, resultError }
};

// Bumped on every navigation (session switch, tab switch, re-render). Async work
// (plan/implement requests, status/diff/setup fetches) captures the value at the moment
// it starts and checks it again once it resolves — if the user has since navigated
// elsewhere, the response is stale and must not touch the DOM (it would otherwise
// silently overwrite whatever the user is currently looking at).
let viewToken = 0;
function isCurrentView(sessionId, tab, token) {
  return token === viewToken && state.selectedId === sessionId && state.tab === tab;
}

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
  modalBox: document.getElementById("modal-box"),
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

function openModal(title, bodyHtml, { large = false } = {}) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalBox.classList.toggle("modal-lg", large);
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
      <button class="icon-btn" data-customize-project="${p.id}" title="Skills, agents & commands">⚙</button>
      <button class="icon-btn" data-delete-project="${p.id}" title="Delete project">&times;</button>
    `;
    els.projectsList.appendChild(item);
  }

  for (const btn of els.projectsList.querySelectorAll("[data-delete-project]")) {
    btn.addEventListener("click", () => deleteProject(btn.dataset.deleteProject));
  }
  for (const btn of els.projectsList.querySelectorAll("[data-customize-project]")) {
    btn.addEventListener("click", () => openProjectCustomizationsModal(btn.dataset.customizeProject));
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

// ---------- Skills / agents / commands (shared between project + new-session UI) ----------

const CUSTOMIZATION_LABELS = { skill: "Skill", agent: "Agent", command: "Command" };
const CUSTOMIZATION_ICONS = { skill: "✨", agent: "🎭", command: "⚡" };

function customizationFieldsHtml(prefix) {
  return `
    <div class="field">
      <label for="${prefix}-type">Type</label>
      <select id="${prefix}-type">
        <option value="skill">✨ Skill — auto-triggered by OpenCode based on the task</option>
        <option value="agent">🎭 Agent — a selectable persona (model, permissions, prompt)</option>
        <option value="command">⚡ Command — a reusable slash-command template</option>
      </select>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="${prefix}-name">Name</label>
        <input id="${prefix}-name" type="text" placeholder="my-skill" />
        <div class="field-hint">lowercase, hyphen-separated</div>
      </div>
      <div class="field">
        <label for="${prefix}-description">Description</label>
        <input id="${prefix}-description" type="text" placeholder="What it does, when to use it" />
      </div>
    </div>
    <div id="${prefix}-agent-fields" class="field-row" hidden>
      <div class="field">
        <label for="${prefix}-mode">Mode</label>
        <select id="${prefix}-mode">
          <option value="primary">primary</option>
          <option value="subagent">subagent</option>
          <option value="all">all</option>
        </select>
      </div>
      <div class="field">
        <label for="${prefix}-edit-permission">Edit permission</label>
        <select id="${prefix}-edit-permission">
          <option value="ask">ask</option>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
      </div>
    </div>
    <div id="${prefix}-command-fields" class="field" hidden>
      <label for="${prefix}-agent-name">Runs with agent (optional)</label>
      <input id="${prefix}-agent-name" type="text" placeholder="build" />
    </div>
    <div class="field">
      <label for="${prefix}-body">Instructions / prompt / template</label>
      <textarea id="${prefix}-body" rows="4" placeholder="Markdown body. Commands can use $ARGUMENTS."></textarea>
    </div>
  `;
}

function wireCustomizationTypeToggle(prefix) {
  const typeSelect = document.getElementById(`${prefix}-type`);
  const agentFields = document.getElementById(`${prefix}-agent-fields`);
  const commandFields = document.getElementById(`${prefix}-command-fields`);
  const update = () => {
    agentFields.hidden = typeSelect.value !== "agent";
    commandFields.hidden = typeSelect.value !== "command";
  };
  typeSelect.addEventListener("change", update);
  update();
}

// The server requires lowercase-hyphen-digits, starting with a letter (matches
// OpenCode's own naming rule — the name becomes a directory/file name on disk). The
// input just hints at that; without this, a natural name like "plan generator" gets
// staged as-is and only fails at session-creation time, with an error that doesn't say
// which field caused it. Auto-fixing here means the common case never hits that error.
function slugifyCustomizationName(raw) {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "") // must start with a letter — drop any leading digits/hyphens
    .replace(/-+$/, "");
}

function readCustomizationFields(prefix) {
  const type = document.getElementById(`${prefix}-type`).value;
  const nameInput = document.getElementById(`${prefix}-name`);
  const rawName = nameInput.value.trim();
  const name = slugifyCustomizationName(rawName);
  const description = document.getElementById(`${prefix}-description`).value.trim();
  const body = document.getElementById(`${prefix}-body`).value;
  if (!name) {
    showBanner(rawName ? `"${rawName}" needs at least one letter to become a valid ${type} name.` : "Name is required.");
    return null;
  }
  if (!description) {
    showBanner("Description is required.");
    return null;
  }
  nameInput.value = name; // reflect the corrected name so what's shown matches what's sent
  const fields = { type, name, description, body };
  if (type === "agent") {
    fields.mode = document.getElementById(`${prefix}-mode`).value;
    fields.editPermission = document.getElementById(`${prefix}-edit-permission`).value;
  } else if (type === "command") {
    fields.agent = document.getElementById(`${prefix}-agent-name`).value.trim() || undefined;
  }
  return fields;
}

function clearCustomizationFields(prefix) {
  document.getElementById(`${prefix}-name`).value = "";
  document.getElementById(`${prefix}-description`).value = "";
  document.getElementById(`${prefix}-body`).value = "";
}

function renderCustomizationList(items, type, { deletable }) {
  if (items.length === 0) return '<div class="hint">None.</div>';
  return items
    .map((item) => {
      const isCustom = Boolean(item.location && item.location.includes(".opencode/"));
      return `
        <div class="custom-item">
          <span class="type-icon">${CUSTOMIZATION_ICONS[type]}</span>
          <div class="info">
            <div class="name">${escapeHtml(item.name)}${isCustom ? "" : ' <span class="badge">built-in</span>'}</div>
            <div class="desc">${escapeHtml(item.description || "")}</div>
          </div>
          ${isCustom && deletable ? `<button class="icon-btn" data-remove="${type}:${escapeHtml(item.name)}" title="Remove">&times;</button>` : ""}
        </div>
      `;
    })
    .join("");
}

async function openProjectCustomizationsModal(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;

  openModal(`⚙ Customize “${project.name}”`, '<div class="hint">Loading…</div>', { large: true });

  async function render() {
    let data;
    try {
      data = await api(`/api/projects/${projectId}/customizations`);
    } catch (err) {
      els.modalBody.innerHTML = `<div class="hint">Error: ${escapeHtml(err.message)}</div>`;
      return;
    }

    els.modalBody.innerHTML = `
      <p class="hint" style="padding:0">Added here becomes part of the project's repo (committed automatically) —
      every new session created from this project will inherit it. Existing sessions won't see it retroactively.</p>
      ${["skill", "agent", "command"]
        .map(
          (type) => `
        <div class="field">
          <label>${CUSTOMIZATION_ICONS[type]} ${CUSTOMIZATION_LABELS[type]}s</label>
          <div class="custom-list">${renderCustomizationList(data[type], type, { deletable: true })}</div>
        </div>
      `,
        )
        .join("")}
      <div class="field-section">
        <div class="field-section-title">➕ Add new</div>
        ${customizationFieldsHtml("proj-custom")}
        <div class="modal-actions" style="justify-content:flex-start">
          <button id="submit-project-customization" class="primary">Add to project</button>
        </div>
      </div>
    `;

    wireCustomizationTypeToggle("proj-custom");

    for (const btn of els.modalBody.querySelectorAll("[data-remove]")) {
      btn.addEventListener("click", async () => {
        const [type, name] = btn.dataset.remove.split(":");
        try {
          await api(`/api/projects/${projectId}/customizations/${type}/${encodeURIComponent(name)}`, { method: "DELETE" });
          await render();
        } catch (err) {
          showBanner(err.message);
        }
      });
    }

    document.getElementById("submit-project-customization").addEventListener("click", async () => {
      const fields = readCustomizationFields("proj-custom");
      if (!fields) return;
      const btn = document.getElementById("submit-project-customization");
      btn.disabled = true;
      try {
        await api(`/api/projects/${projectId}/customizations`, { method: "POST", body: fields });
        await render();
      } catch (err) {
        showBanner(err.message);
        btn.disabled = false;
      }
    });
  }

  await render();
}

function openAddProjectModal() {
  openModal(
    "📁 Add project",
    `
    <div class="field">
      <label for="project-name">Name</label>
      <input id="project-name" type="text" placeholder="My project" autofocus />
    </div>
    <div class="field">
      <label for="project-repo">Repository URL</label>
      <input id="project-repo" type="text" placeholder="https://github.com/org/repo.git" />
    </div>
    <div class="field">
      <label for="project-branch">Branch <span style="font-weight:400;color:var(--muted)">(optional, defaults to the repo's own default)</span></label>
      <input id="project-branch" type="text" placeholder="main" />
    </div>
    <label class="field-toggle">
      <input type="checkbox" id="project-is-private" />
      🔒 This is a private repository
    </label>
    <div id="project-pat-field" class="field" hidden>
      <label for="project-pat">GitHub Personal Access Token</label>
      <input id="project-pat" type="password" placeholder="ghp_..." autocomplete="off" />
      <div class="field-hint">Stored on the server only, never shown again after saving.</div>
    </div>
    <div class="modal-actions">
      <button id="cancel-add-project">Cancel</button>
      <button id="submit-add-project" class="primary">⬇ Clone &amp; add</button>
    </div>
  `,
  );

  document.getElementById("project-is-private").addEventListener("change", (e) => {
    document.getElementById("project-pat-field").hidden = !e.target.checked;
    if (e.target.checked) document.getElementById("project-pat").focus();
  });

  document.getElementById("cancel-add-project").addEventListener("click", closeModal);
  document.getElementById("submit-add-project").addEventListener("click", async () => {
    const name = document.getElementById("project-name").value.trim();
    const repoUrl = document.getElementById("project-repo").value.trim();
    const branch = document.getElementById("project-branch").value.trim();
    const isPrivate = document.getElementById("project-is-private").checked;
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
        body: { name, repoUrl, branch: branch || undefined, pat: isPrivate && pat ? pat : undefined },
      });
      closeModal();
      await refreshProjects();
    } catch (err) {
      showBanner(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "⬇ Clone & add";
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
    pruneClientState(); // drop any persisted task/console history for sessions that are now gone
  } catch (err) {
    showBanner(err.message);
  }
}

function sessionShortStatus(s) {
  const flow = state.taskFlows.get(s.id);
  const busy = flow?.step === "planning" || flow?.step === "implementing";
  // Short, one-line status so switching sessions doesn't lose sight of what a
  // still-running one is doing — the console tab has the full detail behind this.
  const text = busy
    ? state.sessionStatus.get(s.id)?.text || (flow.step === "planning" ? "Thinking…" : "Implementing…")
    : null;
  return { busy, text };
}

function renderSessions() {
  els.sessionsList.innerHTML = "";
  if (state.sessions.length === 0) {
    els.sessionsList.innerHTML = '<div class="empty-state">No sessions yet.</div>';
    return;
  }
  for (const s of state.sessions) {
    const { busy, text } = sessionShortStatus(s);
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === state.selectedId ? " active" : "");
    item.dataset.sessionId = s.id;
    item.innerHTML = `<div class="title">${busy ? '<span class="mini-spinner" title="Working…"></span>' : ""}${escapeHtml(s.title || shortId(s.id))}</div><div class="branch">${escapeHtml(s.projectName || "")} · ${escapeHtml(s.branch)}</div>${text ? `<div class="session-status">${escapeHtml(text)}</div>` : ""}`;
    item.addEventListener("click", () => selectSession(s.id));
    els.sessionsList.appendChild(item);
  }
}

async function openNewSessionModal() {
  if (state.projects.length === 0) {
    showBanner("Add a project first.");
    return;
  }

  openModal("🚀 New session", '<div class="hint">Loading models and agents…</div>', { large: true });
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

  const stagedCustomizations = [];

  openModal(
    "🚀 New session",
    `
    <div class="field">
      <label for="session-project">📁 Project</label>
      <select id="session-project">${projectOptions}</select>
    </div>
    <div class="field">
      <label for="session-title">Title <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
      <input id="session-title" type="text" placeholder="Fix login bug" />
    </div>

    <div class="field-section">
      <div class="field-section-title">🧠 Model &amp; agent</div>
      <div class="field-row">
        <div class="field">
          <label for="session-agent">Agent</label>
          <select id="session-agent"><option value="">(default)</option>${agentOptions}</select>
        </div>
        <div class="field">
          <label for="session-model">Model</label>
          <select id="session-model"><option value="">(default)</option>${modelOptions}</select>
        </div>
      </div>
      <div class="field-hint">Both apply to every message this session sends, unless overridden per task.</div>
    </div>

    <details class="field">
      <summary>➕ Add a skill/agent/command for this session only</summary>
      <p class="field-hint">Only this session sees it, applied when it's created — it can't be added after
      the fact (OpenCode caches what it discovers in a directory, so only just-created sessions pick up new
      files reliably).</p>
      ${customizationFieldsHtml("new-session-custom")}
      <div class="modal-actions" style="justify-content:flex-start">
        <button id="stage-customization-btn">➕ Add to this session</button>
      </div>
      <div id="staged-customizations-list" class="staged-list"></div>
    </details>

    <div class="modal-actions">
      <button id="cancel-new-session">Cancel</button>
      <button id="submit-new-session" class="primary">✓ Create</button>
    </div>
  `,
    { large: true },
  );

  wireCustomizationTypeToggle("new-session-custom");

  function renderStagedList() {
    const list = document.getElementById("staged-customizations-list");
    if (stagedCustomizations.length === 0) {
      list.innerHTML = "";
      return;
    }
    list.innerHTML = stagedCustomizations
      .map(
        (c, i) =>
          `<div class="custom-item"><span class="type-icon">${CUSTOMIZATION_ICONS[c.type]}</span><div class="info"><div class="name">${escapeHtml(c.name)}</div><div class="desc">${escapeHtml(c.description)}</div></div><button class="icon-btn" data-unstage="${i}" title="Remove">&times;</button></div>`,
      )
      .join("");
    for (const btn of list.querySelectorAll("[data-unstage]")) {
      btn.addEventListener("click", () => {
        stagedCustomizations.splice(Number(btn.dataset.unstage), 1);
        renderStagedList();
      });
    }
  }

  document.getElementById("stage-customization-btn").addEventListener("click", () => {
    const fields = readCustomizationFields("new-session-custom");
    if (!fields) return;
    stagedCustomizations.push(fields);
    clearCustomizationFields("new-session-custom");
    renderStagedList();
  });

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
        body: {
          projectId,
          title: title || undefined,
          agent: agent || undefined,
          model,
          customizations: stagedCustomizations.length ? stagedCustomizations : undefined,
        },
      });
      closeModal();
      await refreshSessions();
      selectSession(created.id);
    } catch (err) {
      showBanner(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "✓ Create";
    }
  });
}

els.newSessionBtn.addEventListener("click", openNewSessionModal);

// Closes one session's live console connection. Deliberately not called just because
// the user navigated away — a busy session keeps streaming in the background so its
// status/console stays accurate when the user switches back. Only called once that
// session's task has actually finished (or the session itself is gone).
function closeEventSource(sessionId) {
  const es = state.eventSources.get(sessionId);
  if (es) {
    es.close();
    state.eventSources.delete(sessionId);
  }
}

function selectSession(id) {
  state.selectedId = id;
  state.tab = "task";
  renderSessions();
  renderDetail();
}

function renderDetail() {
  viewToken++;
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
      <button class="tab-btn" data-tab="setup">Setup</button>
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
      state.consoleLines.delete(session.id);
      state.sessionStatus.delete(session.id);
      closeEventSource(session.id);
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
  const tab = state.tab;
  const token = viewToken;
  const stillCurrent = () => isCurrentView(session.id, tab, token);

  if (tab === "task") {
    renderTaskTab(session);
    return;
  }

  if (tab === "console") {
    container.innerHTML = '<div id="console-log" class="console-log"></div>';
    openConsole(session.id, "console-log");
    return;
  }

  if (tab === "status") {
    container.innerHTML = '<pre class="code-view">Loading…</pre>';
    let text;
    try {
      const data = await api(`/api/sessions/${session.id}/status`);
      text = data.status.trim() || "Working tree clean.";
    } catch (err) {
      text = "Error: " + err.message;
    }
    if (stillCurrent()) container.querySelector("pre").textContent = text;
    return;
  }

  if (tab === "diff") {
    container.innerHTML = '<pre class="code-view">Loading…</pre>';
    let text;
    try {
      const diff = await api(`/api/sessions/${session.id}/diff`);
      text = diff.trim() || "No changes yet.";
    } catch (err) {
      text = "Error: " + err.message;
    }
    if (stillCurrent()) container.querySelector("pre").textContent = text;
    return;
  }

  if (tab === "setup") {
    container.innerHTML = '<div class="hint" style="padding:20px">Loading…</div>';
    let html;
    try {
      const data = await api(`/api/sessions/${session.id}/customizations`);
      html = `
        <div id="task-step-body">
          <div class="task-card">
            <p class="hint">What this session actually sees right now: built-ins, whatever the project's
            repo has committed, and anything added at creation time. Read-only — see the New Session dialog
            to add session-only ones, or the project's ⚙ button for ones every future session should inherit.</p>
            ${["skill", "agent", "command"]
              .map(
                (type) => `
              <div class="field">
                <label>${CUSTOMIZATION_LABELS[type]}s</label>
                <div class="custom-list">${renderCustomizationList(data[type], type, { deletable: false })}</div>
              </div>
            `,
              )
              .join("")}
          </div>
        </div>
      `;
    } catch (err) {
      html = `<div class="hint" style="padding:20px">Error: ${escapeHtml(err.message)}</div>`;
    }
    if (stillCurrent()) container.innerHTML = html;
  }
}

// ---------- Console (live event stream) ----------

// Console detail lives in state.consoleLines (per session), independent of any DOM
// element — a session keeps accumulating its full history in the background even while
// the user is looking at a different session, so switching back never loses it. This
// map holds only the currently-mounted container's line elements, for in-place updates
// (a tool going pending -> running -> completed, or streaming text, updates one line
// instead of spamming duplicates) — it's cleared and rebuilt each time a console mounts.
const consoleLineElements = new Map();
const CONSOLE_HISTORY_LIMIT = 300; // caps memory/localStorage growth on a long-running task

// Tool-call/text events can tick several times a second — writing to localStorage on
// every single one would be wasteful and janky. Debouncing collapses a burst into one
// write shortly after it settles.
let saveClientStateTimer = null;
function saveClientStateDebounced() {
  clearTimeout(saveClientStateTimer);
  saveClientStateTimer = setTimeout(saveClientState, 400);
}

// Updates (or appends, if `key` is new) one line in a session's full history, and
// mirrors it to the DOM only if that session's console is the one currently on screen.
function upsertConsoleLine(sessionId, key, className, icon, text) {
  if (!state.consoleLines.has(sessionId)) state.consoleLines.set(sessionId, []);
  const lines = state.consoleLines.get(sessionId);
  const existing = lines.find((l) => l.key === key);
  if (existing) Object.assign(existing, { className, icon, text });
  else {
    lines.push({ key, className, icon, text });
    if (lines.length > CONSOLE_HISTORY_LIMIT) lines.splice(0, lines.length - CONSOLE_HISTORY_LIMIT);
  }
  saveClientStateDebounced();

  const log = document.getElementById("task-console-log") || document.getElementById("console-log");
  if (!log || log.dataset.sessionId !== sessionId) return;
  let line = consoleLineElements.get(key);
  if (!line) {
    line = document.createElement("div");
    line.innerHTML = '<span class="icon"></span><span class="text"></span>';
    log.appendChild(line);
    consoleLineElements.set(key, line);
  }
  line.className = "console-line " + className;
  line.querySelector(".icon").textContent = icon;
  line.querySelector(".text").textContent = text;
  log.scrollTop = log.scrollHeight;
}

function appendConsoleLine(sessionId, className, icon, text) {
  upsertConsoleLine(sessionId, `once-${Date.now()}-${Math.random()}`, className, icon, text);
}

// The sidebar's short status line for a busy session — kept separate from the console's
// full detail so the main list stays scannable while the console shows everything.
// Tool-call events can tick several times a second while implementing; patching just
// this one row's text in place (instead of rebuilding the whole sidebar list on every
// tick) is what keeps the list from flickering.
function setShortStatus(sessionId, text) {
  state.sessionStatus.set(sessionId, { text });
  const item = els.sessionsList.querySelector(`[data-session-id="${sessionId}"]`);
  const statusEl = item?.querySelector(".session-status");
  if (statusEl) statusEl.textContent = text;
  else renderSessions(); // row not mounted yet, or has no status line (busy state just changed) — full rebuild
}

function handleConsoleEvent(sessionId, event) {
  const p = event.properties || {};
  switch (event.type) {
    case "message.part.updated": {
      const part = p.part;
      if (part?.type === "tool") {
        const status = part.state?.status;
        const title = part.state?.title || part.tool;
        if (status === "pending") upsertConsoleLine(sessionId, part.id, "tool", "⏱️", `${part.tool} — queued…`);
        else if (status === "running") {
          upsertConsoleLine(sessionId, part.id, "tool", "🔧", `${part.tool} — ${title}…`);
          setShortStatus(sessionId, `${part.tool}…`);
        } else if (status === "completed") upsertConsoleLine(sessionId, part.id, "tool", "✅", `${part.tool} — ${title}`);
        else if (status === "error")
          upsertConsoleLine(sessionId, part.id, "error", "❌", `${part.tool} failed: ${part.state?.error || ""}`);
      } else if (part?.type === "text" && part.text) {
        upsertConsoleLine(sessionId, part.id, "text", "💬", part.text);
      }
      break;
    }
    case "file.edited":
      appendConsoleLine(sessionId, "file", "✏️", `edited ${p.file}`);
      break;
    case "session.status":
      appendConsoleLine(sessionId, "status", p.status?.type === "busy" ? "⏳" : "💤", `session ${p.status?.type}`);
      if (p.status?.type === "retry") setShortStatus(sessionId, `Retrying (${p.status.attempt})…`);
      break;
    case "session.idle":
      appendConsoleLine(sessionId, "status", "✔️", "session idle");
      break;
    case "session.error":
      appendConsoleLine(sessionId, "error", "❌", p.error?.data?.message || p.error?.name || "session error");
      break;
    case "session.diff": {
      const files = (p.diff || []).length;
      if (files > 0) appendConsoleLine(sessionId, "file", "📝", `${files} file(s) changed`);
      break;
    }
    default:
      break;
  }
}

// Mounts a session's console into containerId, replayed from its full history (so
// switching sessions and back shows everything that happened while away), and opens a
// live connection only if one isn't already streaming for it in the background.
function openConsole(sessionId, containerId) {
  const log = document.getElementById(containerId);
  if (log) {
    log.dataset.sessionId = sessionId;
    log.innerHTML = "";
    consoleLineElements.clear();
    for (const line of state.consoleLines.get(sessionId) || []) {
      const el = document.createElement("div");
      el.innerHTML = '<span class="icon"></span><span class="text"></span>';
      el.className = "console-line " + line.className;
      el.querySelector(".icon").textContent = line.icon;
      el.querySelector(".text").textContent = line.text;
      log.appendChild(el);
      consoleLineElements.set(line.key, el);
    }
    log.scrollTop = log.scrollHeight;
  }

  if (state.eventSources.has(sessionId)) return; // already streaming in the background

  const url = `/api/sessions/${sessionId}/events?token=${encodeURIComponent(state.token)}`;
  const es = new EventSource(url);
  state.eventSources.set(sessionId, es);

  es.onmessage = (msg) => {
    try {
      handleConsoleEvent(sessionId, JSON.parse(msg.data));
    } catch {
      // ignore malformed/comment frames
    }
  };
  es.onerror = () => {
    appendConsoleLine(sessionId, "error", "⚠️", "Connection lost, retrying…");
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

// Shown instead of the plain spinner once polling has given up waiting (see
// REPLY_POLL_MAX_ATTEMPTS) but the task itself was never confirmed to have errored — it
// may well still be working. Deliberately not the "done" screen: there's no confirmed
// result yet, so offering "Create PR" or "View diff" here would imply a finished state
// we don't actually know is true. Retry just resumes polling the same message.
function renderTimedOutCard(session, flow, label, hint) {
  const container = document.getElementById("tab-content");
  const body = document.getElementById("task-step-body") || container;
  body.innerHTML = `
    <div class="task-card task-loading">
      <p>⏱️ Still running — ${escapeHtml(label.toLowerCase())} is taking longer than expected.</p>
      ${hint ? `<p class="hint">${hint}</p>` : ""}
      <p class="hint">It may well still be working — the console below shows live activity if so.</p>
      <div id="task-console-log" class="console-log"></div>
      <div class="task-actions">
        <button id="retry-poll-btn" class="primary">↻ Retry</button>
      </div>
    </div>
  `;
  openConsole(session.id, "task-console-log");
  document.getElementById("retry-poll-btn").addEventListener("click", () => resumeFlow(session, flow));
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
    if (flow.timedOut) {
      renderTimedOutCard(session, flow, "Thinking through a plan…", `“${escapeHtml(flow.taskText)}”`);
      return;
    }
    body.innerHTML = `
      <div class="task-card task-loading">
        <div class="spinner"></div>
        <p>Thinking through a plan…</p>
        <p class="hint">“${escapeHtml(flow.taskText)}”</p>
        <div id="task-console-log" class="console-log"></div>
      </div>
    `;
    openConsole(session.id, "task-console-log");
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
    if (flow.timedOut) {
      renderTimedOutCard(session, flow, "Implementing the plan…");
      return;
    }
    body.innerHTML = `
      <div class="task-card implementing-card">
        <div class="implementing-header">
          <div class="spinner small"></div>
          <span>Implementing the plan…</span>
        </div>
        <div id="task-console-log" class="console-log"></div>
      </div>
    `;
    openConsole(session.id, "task-console-log");
    return;
  }

  if (flow.step === "done") {
    const prControl = flow.prUrl
      ? `<a href="${escapeHtml(flow.prUrl)}" target="_blank" rel="noopener" class="pr-link">↗ View PR #${flow.prNumber}</a>`
      : `<button id="create-pr-btn" ${flow.prCreating ? "disabled" : ""}>${flow.prCreating ? "Creating PR…" : "Create PR"}</button>`;

    body.innerHTML = `
      <div class="task-card">
        <h3>${flow.resultError ? "⚠️ Finished with an error" : "✅ Done"}</h3>
        <div class="plan-content">${renderMarkdownLite(flow.resultError || flow.resultText)}</div>
        ${flow.prError ? `<div class="pr-error">${escapeHtml(flow.prError)}</div>` : ""}
        <div class="task-actions">
          <button id="view-diff-btn">View diff</button>
          ${prControl}
          <button id="new-task-btn" class="primary">Start another task</button>
        </div>
      </div>
    `;
    document.getElementById("view-diff-btn").addEventListener("click", () => {
      state.tab = "diff";
      renderDetail();
    });
    if (!flow.prUrl) {
      document.getElementById("create-pr-btn").addEventListener("click", () => createPr(session, flow));
    }
    document.getElementById("new-task-btn").addEventListener("click", () => {
      state.taskFlows.set(session.id, { step: "input", taskText: "", planText: "", resultText: "", resultError: null });
      state.consoleLines.delete(session.id);
      saveClientState();
      renderTaskTab(session);
    });
  }
}

function sessionLabel(session) {
  return session.title || shortId(session.id);
}

const REPLY_POLL_INTERVAL_MS = 1500;
const REPLY_POLL_MAX_ATTEMPTS = 800; // ~20 minutes — a real "implement" turn (scaffold, install, write, lint, build) has been observed taking 14+ minutes of genuine, uninterrupted progress; this is a soft cap (see "timeout" status below), not a hard failure
const CLIENT_STATE_KEY = "taskState";

// taskFlows + consoleLines are what a reload would otherwise wipe out from memory —
// persisting them (and flow.pendingMessageId, see below) is what lets resumePendingTasks
// pick a still-running task back up instead of just showing a frozen, stale spinner.
function saveClientState() {
  try {
    localStorage.setItem(
      CLIENT_STATE_KEY,
      JSON.stringify({
        taskFlows: [...state.taskFlows.entries()],
        consoleLines: [...state.consoleLines.entries()],
      }),
    );
  } catch {
    // storage full or unavailable (private browsing, etc.) — the task still runs, it
    // just won't survive a reload this time.
  }
}

function loadClientState() {
  try {
    const raw = localStorage.getItem(CLIENT_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [id, flow] of parsed.taskFlows || []) state.taskFlows.set(id, flow);
    for (const [id, lines] of parsed.consoleLines || []) state.consoleLines.set(id, lines);
  } catch {
    // corrupt/old-shape data — ignore and start fresh rather than fail to load the app.
  }
}

// Drops persisted state for sessions that no longer exist server-side, so localStorage
// doesn't grow forever as sessions get created and deleted over time.
function pruneClientState() {
  const liveIds = new Set(state.sessions.map((s) => s.id));
  for (const id of [...state.taskFlows.keys()]) if (!liveIds.has(id)) state.taskFlows.delete(id);
  for (const id of [...state.consoleLines.keys()]) if (!liveIds.has(id)) state.consoleLines.delete(id);
  saveClientState();
}

// Polls for one message's reply — the piece shared by sending a fresh message and by
// resuming a poll left mid-flight by a reload (which only has the messageId to go on).
//
// "timeout" is deliberately its own status, distinct from "error": we've seen a real
// implement turn still making genuine, uninterrupted progress well past this cap (see
// REPLY_POLL_MAX_ATTEMPTS) — treating that as a failure discards a task that was
// actually succeeding. The caller keeps pendingMessageId around so a "Retry" can just
// resume polling the same message rather than losing the work and starting over.
async function pollReply(sessionId, messageId) {
  for (let attempt = 0; attempt < REPLY_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, REPLY_POLL_INTERVAL_MS));
    const result = await api(`/api/sessions/${sessionId}/messages/${messageId}/reply`);
    if (result.status === "done" || result.status === "error") return result;
  }
  return { status: "timeout" };
}

// POST /messages returns as soon as OpenCode accepts the message — the actual turn
// (tool calls, retries, sometimes minutes of work) happens in the background. This
// polls the server for the assistant's reply instead of holding one HTTP request open
// for however long that takes. onStart fires with the messageId as soon as it's known,
// so the caller can persist it before the (potentially long) poll even begins.
async function sendMessageAndAwaitReply(sessionId, body, onStart) {
  const { messageId } = await api(`/api/sessions/${sessionId}/messages`, { method: "POST", body });
  if (onStart) onStart(messageId);
  return pollReply(sessionId, messageId);
}

function finishPlanning(session, flow, result, stillCurrent) {
  // Still might be working — leave pendingMessageId and the console connection alone so
  // "Retry" (or the next reload) can just keep polling the same message, not restart it.
  if (result.status === "timeout") {
    flow.timedOut = true;
    saveClientState();
    return;
  }
  flow.timedOut = false;
  closeEventSource(session.id);
  state.sessionStatus.delete(session.id);
  flow.pendingMessageId = null;
  if (result.status === "error") {
    const message = result.error?.data?.message || result.error?.name || "Planning failed";
    showBanner(stillCurrent() ? message : `“${sessionLabel(session)}”: ${message}`);
    flow.step = "input";
  } else {
    flow.planText = result.reply || "(no plan text returned)";
    flow.step = "plan";
    if (!stillCurrent()) showBanner(`Plan ready for “${sessionLabel(session)}” — switch to it to review.`);
  }
  saveClientState();
}

function finishImplementing(session, flow, result, stillCurrent) {
  if (result.status === "timeout") {
    flow.timedOut = true;
    saveClientState();
    return;
  }
  flow.timedOut = false;
  closeEventSource(session.id);
  state.sessionStatus.delete(session.id);
  flow.pendingMessageId = null;
  if (result.status === "error") {
    flow.resultError = result.error?.data?.message || result.error?.name || "Implementation failed";
    flow.resultText = "";
  } else {
    flow.resultText = result.reply || "(no reply text)";
    flow.resultError = null;
  }
  flow.step = "done";
  if (!stillCurrent()) {
    showBanner(
      flow.resultError
        ? `“${sessionLabel(session)}” finished with an error — switch to it to see what happened.`
        : `“${sessionLabel(session)}” finished implementing — switch to it to see the result.`,
    );
  }
  saveClientState();
}

async function generatePlan(session, flow) {
  const token = viewToken;
  const stillCurrent = () => isCurrentView(session.id, "task", token);

  flow.step = "planning";
  state.consoleLines.delete(session.id); // fresh detail log for this task attempt
  state.sessionStatus.delete(session.id);
  if (stillCurrent()) renderTaskTab(session);
  renderSessions(); // shows the busy indicator next to this session in the sidebar
  try {
    // Always plan with OpenCode's built-in read-only "plan" agent, regardless of the
    // session's own default agent, so proposing a plan never edits files.
    const result = await sendMessageAndAwaitReply(session.id, { text: flow.taskText, agent: "plan" }, (messageId) => {
      flow.pendingMessageId = messageId;
      saveClientState();
    });
    // Not gated on stillCurrent() — this session may still be streaming in the
    // background for another view (or none), and its task just finished either way.
    finishPlanning(session, flow, result, stillCurrent);
  } catch (err) {
    closeEventSource(session.id);
    state.sessionStatus.delete(session.id);
    flow.pendingMessageId = null;
    showBanner(stillCurrent() ? err.message : `“${sessionLabel(session)}”: ${err.message}`);
    flow.step = "input";
    saveClientState();
  }
  // Still applies even if the user navigated away: next time they open this session's
  // Task tab, renderTaskTab reads flow.step fresh and shows the right screen. Only the
  // *immediate* re-render is skipped so a slow response can't clobber whatever the user
  // is looking at now.
  if (stillCurrent()) renderTaskTab(session);
  renderSessions();
}

async function implementPlan(session, flow) {
  const token = viewToken;
  const stillCurrent = () => isCurrentView(session.id, "task", token);

  flow.step = "implementing";
  if (stillCurrent()) renderTaskTab(session);
  renderSessions();
  // If the session's own default agent is itself the read-only "plan" agent, force
  // "build" for the implementation step so accepting a plan can actually edit files.
  const implementAgent = session.agent && session.agent !== "plan" ? session.agent : "build";
  try {
    const result = await sendMessageAndAwaitReply(
      session.id,
      { text: "Proceed and implement the plan you just proposed.", agent: implementAgent },
      (messageId) => {
        flow.pendingMessageId = messageId;
        saveClientState();
      },
    );
    // Not gated on stillCurrent() — this session's console may still be streaming in
    // the background for another view, and its task just finished either way.
    finishImplementing(session, flow, result, stillCurrent);
  } catch (err) {
    closeEventSource(session.id);
    state.sessionStatus.delete(session.id);
    flow.pendingMessageId = null;
    showBanner(stillCurrent() ? err.message : `“${sessionLabel(session)}”: ${err.message}`);
    flow.step = "plan";
    saveClientState();
  }
  if (stillCurrent()) renderTaskTab(session);
  renderSessions();
}

// Commits whatever the agent left uncommitted, pushes the session's branch, and opens a
// PR against the project's default branch — server-side (see POST /:id/pr), this just
// drives the button's loading/result state.
async function createPr(session, flow) {
  const token = viewToken;
  const stillCurrent = () => isCurrentView(session.id, "task", token);

  flow.prCreating = true;
  flow.prError = null;
  if (stillCurrent()) renderTaskTab(session);
  try {
    const result = await api(`/api/sessions/${session.id}/pr`, {
      method: "POST",
      body: { title: session.title, body: flow.resultText },
    });
    flow.prUrl = result.url;
    flow.prNumber = result.number;
  } catch (err) {
    flow.prError = err.message;
  }
  flow.prCreating = false;
  saveClientState();
  if (stillCurrent()) renderTaskTab(session);
  else showBanner(flow.prError ? `PR failed for “${sessionLabel(session)}”: ${flow.prError}` : `PR opened for “${sessionLabel(session)}”.`);
}

// Resumes polling a flow's pendingMessageId from wherever it was left — used both by the
// "Retry" button (after a timeout) and by resumePendingTasks (after a reload). Doesn't
// re-send anything; the original message is still being worked on server-side, this just
// picks the polling back up.
async function resumeFlow(session, flow) {
  const token = viewToken;
  const stillCurrent = () => isCurrentView(session.id, "task", token);
  flow.timedOut = false;
  if (stillCurrent()) renderTaskTab(session);
  if (state.selectedId === session.id && state.tab === "task") openConsole(session.id, "task-console-log");
  const finish = flow.step === "planning" ? finishPlanning : finishImplementing;
  const result = await pollReply(session.id, flow.pendingMessageId);
  finish(session, flow, result, stillCurrent);
  if (stillCurrent()) renderTaskTab(session);
  renderSessions();
}

// Called once at startup, after the session list loads. A page reload wipes every
// in-flight poll loop (they're just JS closures) — this picks each still-"planning" or
// "implementing" flow back up from the messageId that was persisted before the reload,
// reopening its console too, so the user doesn't come back to a permanently frozen
// spinner over stale data.
async function resumePendingTasks() {
  for (const [sessionId, flow] of state.taskFlows) {
    if (!flow.pendingMessageId) continue;
    if (flow.step !== "planning" && flow.step !== "implementing") continue;
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) {
      state.taskFlows.delete(sessionId); // session was deleted while we were away
      continue;
    }
    resumeFlow(session, flow);
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
loadClientState(); // restore task console/status history that a reload would otherwise drop
if (state.token) {
  refreshProjects();
  refreshSessions().then(resumePendingTasks); // pick back up any task still running server-side
}
