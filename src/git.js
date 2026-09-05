import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./httpError.js";

const execFileAsync = promisify(execFile);

const REPO_DIR = path.resolve(process.env.REPO_DIR || "./repo");
const WORKTREES_DIR = path.resolve(process.env.WORKTREES_DIR || "./worktrees");

// sessionId -> { path, branch, opencodeId }
const sessions = new Map();

async function git(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    throw new HttpError(400, `git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function ensureRepoReady() {
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPO_DIR });
  } catch {
    throw new Error(
      `REPO_DIR (${REPO_DIR}) is not a git repository with at least one commit. ` +
        "Clone the project you want OpenCode to work on into that path before starting the server.",
    );
  }
  await fs.mkdir(WORKTREES_DIR, { recursive: true });
}

export async function addWorktree() {
  const sessionId = randomUUID();
  const worktreePath = path.join(WORKTREES_DIR, sessionId);
  const branch = `session/${sessionId}`;

  await git(["worktree", "add", worktreePath, "-b", branch], REPO_DIR);

  sessions.set(sessionId, { path: worktreePath, branch, opencodeId: null });
  return { sessionId, path: worktreePath, branch };
}

export function attachOpencodeId(sessionId, opencodeId) {
  const record = getWorktree(sessionId);
  record.opencodeId = opencodeId;
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

export async function removeWorktree(sessionId, { force = false } = {}) {
  const record = getWorktree(sessionId);

  if (!force) {
    const status = await git(["status", "--porcelain"], record.path);
    if (status.trim().length > 0) {
      throw new HttpError(
        409,
        `Session ${sessionId}'s worktree has uncommitted changes. Pass ?force=true to discard them.`,
      );
    }
  }

  const args = ["worktree", "remove", record.path];
  if (force) args.push("--force");
  await git(args, REPO_DIR);

  sessions.delete(sessionId);
}

export async function statusFor(sessionId) {
  const record = getWorktree(sessionId);
  return git(["status", "--porcelain"], record.path);
}

export async function diffFor(sessionId) {
  const record = getWorktree(sessionId);
  return git(["diff"], record.path);
}
