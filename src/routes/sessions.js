import { randomUUID } from "node:crypto";
import { Router } from "express";
import * as customizations from "../customizations.js";
import { streamSessionEvents } from "../events.js";
import * as git from "../git.js";
import { HttpError } from "../httpError.js";
import { getClient } from "../opencode.js";
import * as projects from "../projects.js";

export const sessionsRouter = Router();

function extractReplyText(promptData) {
  const parts = promptData?.parts || [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function validateModel(model) {
  if (model === undefined || model === null) return undefined;
  if (typeof model !== "object" || !model.providerID || !model.modelID) {
    throw new HttpError(400, 'model must be an object like { "providerID": "...", "modelID": "..." }');
  }
  return { providerID: model.providerID, modelID: model.modelID };
}

sessionsRouter.post("/", async (req, res) => {
  const { projectId, title, agent, model, customizations: customList } = req.body || {};
  if (!projectId || typeof projectId !== "string") {
    throw new HttpError(400, 'Request body must include a "projectId" string');
  }
  if (customList !== undefined && !Array.isArray(customList)) {
    throw new HttpError(400, "customizations must be an array");
  }

  const project = projects.getProject(projectId); // 404 if unknown
  const validatedModel = validateModel(model);
  const worktree = await git.addWorktree(project);

  try {
    // Session-only skills/agents/commands, applied to this worktree before OpenCode
    // ever looks at it. This ordering matters: OpenCode caches what it discovers in a
    // directory for the life of its process, with no live invalidation, so writing
    // these before the directory's first-ever query is the only way that's guaranteed
    // to work — adding them to an already-created session would silently not apply
    // until the whole app restarts, which is why that isn't offered as a separate step.
    for (const item of customList || []) {
      await customizations.addCustomization(worktree.path, item.type, item);
    }

    const client = getClient();
    const { data, error } = await client.session.create({
      query: { directory: worktree.path },
      body: title ? { title } : undefined,
    });

    if (error) {
      throw new HttpError(502, "Failed to create OpenCode session", error);
    }

    await git.updateSession(worktree.sessionId, {
      opencodeId: data.id,
      title: data.title,
      agent: agent || null,
      model: validatedModel || null,
    });

    res.status(201).json({
      id: worktree.sessionId,
      branch: worktree.branch,
      path: worktree.path,
      projectId: project.id,
      projectName: project.name,
      opencodeSessionId: data.id,
      title: data.title,
      agent: agent || null,
      model: validatedModel || null,
    });
  } catch (err) {
    await git.removeWorktree(worktree.sessionId, { force: true }).catch(() => {});
    throw err;
  }
});

sessionsRouter.get("/", (req, res) => {
  const projectById = new Map(projects.listProjects().map((p) => [p.id, p]));
  const list = git.listSessions().map((s) => ({ ...s, projectName: projectById.get(s.projectId)?.name }));
  res.json(list);
});

sessionsRouter.delete("/:id", async (req, res) => {
  const record = git.getWorktree(req.params.id);
  const client = getClient();

  const { error } = await client.session.delete({
    path: { id: record.opencodeId },
    query: { directory: record.path },
  });
  // Idempotent: a retry after a failed (e.g. dirty-worktree) delete will find the
  // OpenCode session already gone from a prior attempt — that's fine, not an error.
  if (error && error.name !== "NotFoundError") {
    throw new HttpError(502, "Failed to delete OpenCode session", error);
  }

  const force = req.query.force === "true";
  await git.removeWorktree(req.params.id, { force });

  res.status(204).end();
});

sessionsRouter.get("/:id/messages", async (req, res) => {
  const record = git.getWorktree(req.params.id);
  const client = getClient();

  const { data, error } = await client.session.messages({
    path: { id: record.opencodeId },
    query: { directory: record.path },
  });
  if (error) {
    throw new HttpError(502, "Failed to fetch messages", error);
  }

  res.json(data);
});

sessionsRouter.post("/:id/messages", async (req, res) => {
  const text = req.body?.text;
  if (!text || typeof text !== "string") {
    throw new HttpError(400, 'Request body must include a "text" string');
  }

  const record = git.getWorktree(req.params.id);
  const agent = req.body?.agent || record.agent || undefined;
  const model = validateModel(req.body?.model) || record.model || undefined;
  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;

  const client = getClient();
  // Fire-and-forget: an OpenCode turn can run for minutes (tool calls, retries) and can
  // pause mid-turn on a clarifying question or a permission prompt — blocking here would
  // tie up this request for as long as that takes, or forever if nothing ever answers it.
  // The caller polls GET /:id/messages/:messageId/reply for the result instead.
  const { error } = await client.session.promptAsync({
    path: { id: record.opencodeId },
    query: { directory: record.path },
    body: { messageID: messageId, parts: [{ type: "text", text }], agent, model },
  });
  if (error) {
    throw new HttpError(502, "Failed to send prompt", error);
  }

  res.status(202).json({ messageId });
});

// Polls for the assistant's reply to a message sent via POST /:id/messages. Correlates
// by parentID: promptAsync only lets the caller pick the *user* message's id up front,
// the assistant's reply gets its own id (with parentID set to that) once OpenCode starts
// generating it — so "no matching message yet" is a legitimate pending state, not an error.
//
// One turn can span *several* assistant messages sharing that parentID — OpenCode gives
// each round of tool calls its own message, each with its own completed timestamp. Only
// looking at the first (or even just the latest) one is wrong: an early round is often
// just a tool call with no text, and reporting it "done" hands back an empty reply while
// the agent is still working. The full reply is the text from every round, in order, and
// the turn is only actually over once the session itself goes idle.
sessionsRouter.get("/:id/messages/:messageId/reply", async (req, res) => {
  const record = git.getWorktree(req.params.id);
  const client = getClient();

  const { data, error } = await client.session.messages({
    path: { id: record.opencodeId },
    query: { directory: record.path },
  });
  if (error) {
    throw new HttpError(502, "Failed to fetch messages", error);
  }

  const rounds = data.filter((m) => m.info.role === "assistant" && m.info.parentID === req.params.messageId);
  if (rounds.length === 0) {
    return res.json({ status: "pending" });
  }

  const reply = rounds.map(extractReplyText).filter(Boolean).join("\n\n");
  const last = rounds[rounds.length - 1];
  const failed = rounds.find((r) => r.info.error);
  if (failed) {
    return res.json({ status: "error", error: failed.info.error, reply });
  }
  if (!last.info.time.completed) {
    return res.json({ status: "pending", reply });
  }

  const { data: statusData } = await client.session.status({ query: { directory: record.path } });
  if (statusData?.[record.opencodeId]?.type === "busy") {
    return res.json({ status: "pending", reply }); // this round is done, but another is already starting
  }

  res.json({ status: "done", reply, message: last.info, parts: rounds.flatMap((r) => r.parts) });
});

sessionsRouter.get("/:id/status", async (req, res) => {
  const status = await git.statusFor(req.params.id);
  res.json({ status });
});

sessionsRouter.get("/:id/diff", async (req, res) => {
  const diff = await git.diffFor(req.params.id);
  res.type("text/plain").send(diff);
});

// The agent's own tool calls never commit (see git.commitAll) — a session's changes are
// normally just uncommitted worktree edits. Opening a PR commits whatever's there, pushes
// the session's branch, and opens the PR via GitHub's REST API using the project's PAT.
// GitHub-only: this app only ever clones over plain HTTPS, so a repoUrl that doesn't
// match github.com isn't something this app itself created (hand-edited data, most
// likely a local path used for a scratch project) — there's no PR host to talk to.
sessionsRouter.post("/:id/pr", async (req, res) => {
  const record = git.getWorktree(req.params.id);
  const project = projects.getProject(record.projectId);

  const match = project.repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(\.git)?\/?$/);
  if (!match) {
    throw new HttpError(400, "Creating a pull request needs a github.com HTTPS repo URL — this project's isn't one.");
  }
  if (!project.pat) {
    throw new HttpError(400, "This project has no GitHub token configured — add one (project settings) to push and open a PR.");
  }
  const [, owner, repo] = match;

  const title = (req.body?.title || record.title || `opencode-remote: ${record.branch}`).trim();
  const body = req.body?.body || "Opened via opencode-remote.";

  await git.commitAll(req.params.id, `${title}\n\nMade via opencode-remote.`);
  await git.pushSessionBranch(req.params.id, project.pat);
  const base = await git.projectBaseBranch(project);

  const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${project.pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, head: record.branch, base, body }),
  });
  const data = await ghRes.json();
  if (!ghRes.ok) {
    throw new HttpError(ghRes.status, data.message || "GitHub declined to create the pull request", data);
  }

  res.status(201).json({ url: data.html_url, number: data.number });
});

// What this session actually sees: its project's committed skills/agents/commands plus
// any one-off ones given at creation time (see POST / above). Read-only — see the note
// there on why adding to an already-created session isn't offered.
sessionsRouter.get("/:id/customizations", async (req, res) => {
  const record = git.getWorktree(req.params.id);
  res.json(await customizations.listCustomizations(record.path));
});

// Live console: streams OpenCode's tool-call / file-edit / message events for this
// session as they happen. Browsers' EventSource can't set headers, so auth for this
// one route also accepts ?token= (see middleware/auth.js).
sessionsRouter.get("/:id/events", (req, res) => {
  const record = git.getWorktree(req.params.id);

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": connected\n\n");

  const controller = new AbortController();
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  streamSessionEvents(
    record,
    (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
    controller.signal,
  ).catch((err) => {
    if (!controller.signal.aborted) console.error(`Session ${req.params.id} event stream error:`, err.message);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    controller.abort();
  });
});
