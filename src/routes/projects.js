import { Router } from "express";
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
