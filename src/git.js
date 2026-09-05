import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./httpError.js";

const execFileAsync = promisify(execFile);

const WORKTREES_DIR = path.resolve(process.env.WORKTREES_DIR || "./worktrees");

// sessionId -> { path, branch, opencodeId, projectId, projectDir, title, agent, model }
const sessions = new Map();

export async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new HttpError(400, `git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function ensureWorktreesDir() {
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
}

export async function addWorktree(project) {
  const sessionId = randomUUID();
  const worktreePath = path.join(WORKTREES_DIR, project.id, sessionId);
  const branch = `session/${sessionId}`;

  await runGit(["worktree", "add", worktreePath, "-b", branch], project.dir);

  sessions.set(sessionId, {
    path: worktreePath,
    branch,
    opencodeId: null,
    projectId: project.id,
    projectDir: project.dir,
    title: null,
    agent: null,
    model: null,
  });
  return { sessionId, path: worktreePath, branch };
}

export function updateSession(sessionId, patch) {
  const record = getWorktree(sessionId);
  Object.assign(record, patch);
  return record;
}

export function getWorktree(sessionId) {
  const record = sessions.get(sessionId);
  if (!record) {
    throw new HttpError(404, `No session found with id ${sessionId}`);
  }
  return record;
}

export function listSessions() {
  return [...sessions.entries()].map(([id, record]) => ({ id, ...record }));
}

export function hasSessionsForProject(projectId) {
  return [...sessions.values()].some((record) => record.projectId === projectId);
}

export async function removeWorktree(sessionId, { force = false } = {}) {
  const record = getWorktree(sessionId);

  if (!force) {
    const status = await runGit(["status", "--porcelain"], record.path);
    if (status.trim().length > 0) {
      throw new HttpError(
        409,
        `Session ${sessionId}'s worktree has uncommitted changes. Pass ?force=true to discard them.`,
      );
    }
  }

  const args = ["worktree", "remove", record.path];
  if (force) args.push("--force");
  await runGit(args, record.projectDir);

  sessions.delete(sessionId);
}

export async function statusFor(sessionId) {
  const record = getWorktree(sessionId);
  return runGit(["status", "--porcelain"], record.path);
}

export async function diffFor(sessionId) {
  const record = getWorktree(sessionId);
  return runGit(["diff"], record.path);
}
