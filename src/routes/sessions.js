import { Router } from "express";
import * as git from "../git.js";
import { HttpError } from "../httpError.js";
import { getClient } from "../opencode.js";

export const sessionsRouter = Router();

function extractReplyText(promptData) {
  const parts = promptData?.parts || [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

sessionsRouter.post("/", async (req, res) => {
  const worktree = await git.addWorktree();

  try {
    const client = getClient();
    const { data, error } = await client.session.create({
      query: { directory: worktree.path },
      body: req.body?.title ? { title: req.body.title } : undefined,
    });

    if (error) {
      throw new HttpError(502, "Failed to create OpenCode session", error);
    }

    git.attachOpencodeId(worktree.sessionId, data.id);

    res.status(201).json({
      id: worktree.sessionId,
      branch: worktree.branch,
      path: worktree.path,
      opencodeSessionId: data.id,
      title: data.title,
    });
  } catch (err) {
    await git.removeWorktree(worktree.sessionId, { force: true }).catch(() => {});
    throw err;
  }
});

sessionsRouter.get("/", (req, res) => {
  res.json(git.listSessions());
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
  const client = getClient();

  const { data, error } = await client.session.prompt({
    path: { id: record.opencodeId },
    query: { directory: record.path },
    body: { parts: [{ type: "text", text }] },
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
