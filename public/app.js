const state = {
  token: localStorage.getItem("apiToken") || "",
  sessions: [],
  projects: [],
  selectedId: null,
  tab: "task",
  eventSource: null,
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

function readCustomizationFields(prefix) {
  const type = document.getElementById(`${prefix}-type`).value;
  const name = document.getElementById(`${prefix}-name`).value.trim();
  const description = document.getElementById(`${prefix}-description`).value.trim();
  const body = document.getElementById(`${prefix}-body`).value;
  if (!name || !description) {
    showBanner("Name and description are required.");
    return null;
  }
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
    const flow = state.taskFlows.get(s.id);
    const busy = flow?.step === "planning" || flow?.step === "implementing";
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === state.selectedId ? " active" : "");
    item.innerHTML = `<div class="title">${busy ? '<span class="mini-spinner" title="Working…"></span>' : ""}${escapeHtml(s.title || shortId(s.id))}</div><div class="branch">${escapeHtml(s.projectName || "")} · ${escapeHtml(s.branch)}</div>`;
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
  viewToken++;
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

// key -> line element, per container, so a step that fires multiple updates (a tool
// going pending -> running -> completed, or streaming text) updates one line in place
// instead of spamming duplicates — this is what makes the log read as real steps.
const consoleLineElements = new Map();

function upsertConsoleLine(containerId, key, className, icon, text) {
  const log = document.getElementById(containerId);
  if (!log) return;
  const mapKey = `${containerId}:${key}`;
  let line = consoleLineElements.get(mapKey);
  if (!line) {
    line = document.createElement("div");
    line.innerHTML = '<span class="icon"></span><span class="text"></span>';
    log.appendChild(line);
    consoleLineElements.set(mapKey, line);
  }
  line.className = "console-line " + className;
  line.querySelector(".icon").textContent = icon;
  line.querySelector(".text").textContent = text;
  log.scrollTop = log.scrollHeight;
}

function appendConsoleLine(containerId, className, icon, text) {
  upsertConsoleLine(containerId, `once-${Date.now()}-${Math.random()}`, className, icon, text);
}

function handleConsoleEvent(containerId, event) {
  const p = event.properties || {};
  switch (event.type) {
    case "message.part.updated": {
      const part = p.part;
      if (part?.type === "tool") {
        const status = part.state?.status;
        const title = part.state?.title || part.tool;
        if (status === "pending") upsertConsoleLine(containerId, part.id, "tool", "⏱️", `${part.tool} — queued…`);
        else if (status === "running") upsertConsoleLine(containerId, part.id, "tool", "🔧", `${part.tool} — ${title}…`);
        else if (status === "completed") upsertConsoleLine(containerId, part.id, "tool", "✅", `${part.tool} — ${title}`);
        else if (status === "error")
          upsertConsoleLine(containerId, part.id, "error", "❌", `${part.tool} failed: ${part.state?.error || ""}`);
      } else if (part?.type === "text" && part.text) {
        upsertConsoleLine(containerId, part.id, "text", "💬", part.text);
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
  // The container div is freshly re-created each time this is called (a new task run,
  // or switching back to the tab), so drop any stale line references from before.
  for (const key of [...consoleLineElements.keys()]) {
    if (key.startsWith(`${containerId}:`)) consoleLineElements.delete(key);
  }

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

function sessionLabel(session) {
  return session.title || shortId(session.id);
}

async function generatePlan(session, flow) {
  const token = viewToken;
  const stillCurrent = () => isCurrentView(session.id, "task", token);

  flow.step = "planning";
  if (stillCurrent()) renderTaskTab(session);
  renderSessions(); // shows the busy indicator next to this session in the sidebar
  try {
    // Always plan with OpenCode's built-in read-only "plan" agent, regardless of the
    // session's own default agent, so proposing a plan never edits files.
    const result = await api(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      body: { text: flow.taskText, agent: "plan" },
    });
    if (result.message?.error) {
      const message = result.message.error.data?.message || result.message.error.name || "Planning failed";
      showBanner(stillCurrent() ? message : `“${sessionLabel(session)}”: ${message}`);
      flow.step = "input";
    } else {
      flow.planText = result.reply || "(no plan text returned)";
      flow.step = "plan";
      if (!stillCurrent()) showBanner(`Plan ready for “${sessionLabel(session)}” — switch to it to review.`);
    }
  } catch (err) {
    showBanner(stillCurrent() ? err.message : `“${sessionLabel(session)}”: ${err.message}`);
    flow.step = "input";
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
    const result = await api(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      body: { text: "Proceed and implement the plan you just proposed.", agent: implementAgent },
    });
    // Only tear down the live event source if it's still ours — the user may have since
    // navigated to a different session/console, which owns state.eventSource now.
    if (stillCurrent()) closeEventSource();
    if (result.message?.error) {
      flow.resultError = result.message.error.data?.message || result.message.error.name || "Implementation failed";
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
  } catch (err) {
    if (stillCurrent()) {
      closeEventSource();
      showBanner(err.message);
    } else {
      showBanner(`“${sessionLabel(session)}”: ${err.message}`);
    }
    flow.step = "plan";
  }
  if (stillCurrent()) renderTaskTab(session);
  renderSessions();
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
