import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./httpError.js";

const execFileAsync = promisify(execFile);

const WORKTREES_DIR = path.resolve(process.env.WORKTREES_DIR || "./worktrees");
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const STORE_FILE = path.join(DATA_DIR, "sessions.json");

// sessionId -> { path, branch, opencodeId, projectId, projectDir, title, agent, model }
const sessions = new Map();

// Without this, a server restart (crash, redeploy, nodemon reload) drops every session
// from memory while its git worktree and branch keep existing on disk — orphaning it:
// gone from the UI/API but never cleaned up, and impossible to delete afterward.
async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify([...sessions], null, 2), { mode: 0o600 });
  await fs.chmod(STORE_FILE, 0o600);
}

export async function loadSessions() {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    sessions.clear();
    for (const [id, record] of JSON.parse(raw)) sessions.set(id, record);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

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

  // Keep the project's clone caught up before branching a session off it — otherwise a
  // session started right after someone pushes new commits would silently fork from a
  // stale snapshot. Best-effort: a pull can legitimately fail for reasons that shouldn't
  // block starting a session (no network, a diverged local history from --ff-only after
  // a project-level customization commit) — log it and fall back to whatever the clone
  // already has rather than hard-failing session creation over it.
  try {
    await runGit([...authHeaderArgs(project.pat), "pull", "--ff-only"], project.dir);
  } catch (err) {
    console.warn(`Pre-session pull failed for project "${project.name}" (${project.id}): ${err.message}`);
  }

  // `git worktree add -b` needs a commit to branch from — an empty repo (freshly
  // created on GitHub, nothing pushed yet) has no HEAD, which otherwise surfaces as an
  // opaque "not a valid object name: 'HEAD'" straight from git's stderr.
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: project.dir });
  } catch {
    throw new HttpError(
      400,
      `Project "${project.name}" has no commits yet — push at least one commit to its repo before starting a session.`,
    );
  }

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
  await persist();
  return { sessionId, path: worktreePath, branch };
}

export async function updateSession(sessionId, patch) {
  const record = getWorktree(sessionId);
  Object.assign(record, patch);
  await persist();
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
  await persist();
}

export async function statusFor(sessionId) {
  const record = getWorktree(sessionId);
  return runGit(["status", "--porcelain"], record.path);
}

export async function diffFor(sessionId) {
  const record = getWorktree(sessionId);
  return runGit(["diff"], record.path);
}

// Mirrors projects.js's authHeaderArgs — kept separate (not imported) since projects.js
// already imports from this module, and this is small enough that duplicating it beats
// introducing a circular dependency for it.
function authHeaderArgs(pat) {
  if (!pat) return [];
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

// The agent's own tool calls never commit — a session's changes normally just sit as
// uncommitted working-tree edits (that's what Status/Diff show). Opening a PR needs
// actual commits to push, so this stages and commits whatever is there. Returns false
// (no-op) if the worktree was already clean, e.g. a second "Create PR" click.
export async function commitAll(sessionId, message) {
  const record = getWorktree(sessionId);
  const status = await runGit(["status", "--porcelain"], record.path);
  if (status.trim().length === 0) return false;
  await runGit(["add", "-A"], record.path);
  await runGit(["commit", "-m", message], record.path);
  return true;
}

export async function pushSessionBranch(sessionId, pat) {
  const record = getWorktree(sessionId);
  await runGit([...authHeaderArgs(pat), "push", "-u", "origin", record.branch], record.path);
}

// The project's own clone stays checked out on whatever branch it was cloned on (this
// app never switches it), so that's a reliable way to read the repo's base branch
// without a separate API call to ask GitHub for it.
export async function projectBaseBranch(project) {
  const out = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], project.dir);
  return out.trim();
}
