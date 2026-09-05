import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./httpError.js";
import { hasSessionsForProject, runGit } from "./git.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const PROJECTS_DIR = path.resolve(process.env.PROJECTS_DIR || "./projects");
const STORE_FILE = path.join(DATA_DIR, "projects.json");

// PAT is kept only in this in-memory/on-disk record — never returned by toPublic().
let projects = [];

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(projects, null, 2), { mode: 0o600 });
  await fs.chmod(STORE_FILE, 0o600);
}

export async function loadProjects() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(STORE_FILE, "utf8");
    projects = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    projects = [];
  }
}

function toPublic(project) {
  const { pat, ...rest } = project;
  return { ...rest, hasToken: Boolean(pat) };
}

export function listProjects() {
  return projects.map(toPublic);
}

export function getProject(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new HttpError(404, `No project found with id ${id}`);
  }
  return project;
}

function authHeaderArgs(pat) {
  if (!pat) return [];
  // GitHub (and GitLab/Bitbucket-compatible) HTTPS token auth. Injected per-invocation via
  // -c so the token never touches .git/config, the remote URL, or `git remote -v` output.
  const basic = Buffer.from(`x-access-token:${pat}`).toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

export async function addProject({ name, repoUrl, branch, pat }) {
  if (!name || typeof name !== "string") {
    throw new HttpError(400, 'Request body must include a "name" string');
  }
  if (!repoUrl || typeof repoUrl !== "string") {
    throw new HttpError(400, 'Request body must include a "repoUrl" string');
  }

  const id = randomUUID();
  const dir = path.join(PROJECTS_DIR, id);

  const args = [...authHeaderArgs(pat), "clone"];
  if (branch) args.push("--branch", branch);
  args.push(repoUrl, dir);

  try {
    await runGit(args, PROJECTS_DIR);
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw new HttpError(400, `Failed to clone repository: ${err.message}`);
  }

  const project = {
    id,
    name,
    repoUrl,
    branch: branch || null,
    pat: pat || null,
    dir,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  await persist();

  return toPublic(project);
}

export async function pullProject(id) {
  const project = getProject(id);
  const args = [...authHeaderArgs(project.pat), "pull", "--ff-only"];
  await runGit(args, project.dir);
  return toPublic(project);
}

export async function removeProject(id) {
  const project = getProject(id);

  if (hasSessionsForProject(id)) {
    throw new HttpError(409, `Project ${id} still has active sessions. Delete them first.`);
  }

  await fs.rm(project.dir, { recursive: true, force: true });
  projects = projects.filter((p) => p.id !== id);
  await persist();
}
