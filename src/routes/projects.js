import { Router } from "express";
import * as customizations from "../customizations.js";
import { runGit } from "../git.js";
import * as projects from "../projects.js";

export const projectsRouter = Router();

projectsRouter.get("/", (req, res) => {
  res.json(projects.listProjects());
});

projectsRouter.post("/", async (req, res) => {
  const { name, repoUrl, branch, pat } = req.body || {};
  const project = await projects.addProject({ name, repoUrl, branch, pat });
  res.status(201).json(project);
});

projectsRouter.post("/:id/pull", async (req, res) => {
  const project = await projects.pullProject(req.params.id);
  res.json(project);
});

projectsRouter.delete("/:id", async (req, res) => {
  await projects.removeProject(req.params.id);
  res.status(204).end();
});

// Project-level skills/agents/commands: committed into the project's own repo, so
// every session created from this point on inherits them (a new session's worktree
// forks from this branch's committed state). Sessions that already exist won't
// retroactively see it — add it at the session level too if you need that.
projectsRouter.get("/:id/customizations", async (req, res) => {
  const project = projects.getProject(req.params.id);
  res.json(await customizations.listOwnCustomizations(project.dir));
});

async function commitIfChanged(dir, message) {
  const status = await runGit(["status", "--porcelain", "--", ".opencode"], dir);
  if (status.trim().length === 0) return; // identical content re-added, or nothing left to remove
  await runGit(["commit", "-m", message], dir);
}

projectsRouter.post("/:id/customizations", async (req, res) => {
  const project = projects.getProject(req.params.id);
  const { type, ...fields } = req.body || {};
  const created = await customizations.addCustomization(project.dir, type, fields);
  await runGit(["add", created.path], project.dir);
  await commitIfChanged(project.dir, `Add ${type} "${fields.name}" via opencode-remote`);
  res.status(201).json(created);
});

projectsRouter.delete("/:id/customizations/:type/:name", async (req, res) => {
  const project = projects.getProject(req.params.id);
  const { type, name } = req.params;
  await customizations.removeCustomization(project.dir, type, name);
  await runGit(["add", "-A", ".opencode"], project.dir);
  await commitIfChanged(project.dir, `Remove ${type} "${name}" via opencode-remote`);
  res.status(204).end();
});
