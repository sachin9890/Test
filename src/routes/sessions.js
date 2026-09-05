import { Router } from "express";
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
  const { projectId, title, agent, model } = req.body || {};
  if (!projectId || typeof projectId !== "string") {
    throw new HttpError(400, 'Request body must include a "projectId" string');
  }

  const project = projects.getProject(projectId); // 404 if unknown
  const validatedModel = validateModel(model);
  const worktree = await git.addWorktree(project);

  try {
    const client = getClient();
    const { data, error } = await client.session.create({
      query: { directory: worktree.path },
      body: title ? { title } : undefined,
    });

    if (error) {
      throw new HttpError(502, "Failed to create OpenCode session", error);
    }

    git.updateSession(worktree.sessionId, {
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

  const client = getClient();
  const { data, error } = await client.session.prompt({
    path: { id: record.opencodeId },
    query: { directory: record.path },
    body: { parts: [{ type: "text", text }], agent, model },
  });
  if (error) {
    throw new HttpError(502, "Failed to send prompt", error);
  }

  res.json({ reply: extractReplyText(data), message: data.info, parts: data.parts });
});

sessionsRouter.get("/:id/status", async (req, res) => {
  const status = await git.statusFor(req.params.id);
  res.json({ status });
});

sessionsRouter.get("/:id/diff", async (req, res) => {
  const diff = await git.diffFor(req.params.id);
  res.type("text/plain").send(diff);
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
