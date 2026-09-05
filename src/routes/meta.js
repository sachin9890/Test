import { Router } from "express";
import { HttpError } from "../httpError.js";
import { getClient } from "../opencode.js";

export const metaRouter = Router();

// Built-in agents that ship with OpenCode even when a project doesn't define custom ones.
const DEFAULT_AGENTS = [
  { name: "build", description: "Full read/write coding agent (default).", builtIn: true },
  { name: "plan", description: "Read-only planning agent — no file edits.", builtIn: true },
];

metaRouter.get("/providers", async (req, res) => {
  const client = getClient();
  // config.providers() returns only providers OpenCode can actually use on this host
  // (credentials configured), unlike provider.list()'s full catalog of every known provider.
  const { data, error } = await client.config.providers();
  if (error) {
    throw new HttpError(502, "Failed to list providers", error);
  }

  const providers = (data.providers || []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    defaultModel: data.default?.[provider.id],
    models: Object.values(provider.models || {}).map((model) => ({ id: model.id, name: model.name })),
  }));

  res.json(providers);
});

metaRouter.get("/agents", async (req, res) => {
  const client = getClient();
  const { data, error } = await client.config.get();
  if (error) {
    throw new HttpError(502, "Failed to load config", error);
  }

  const configured = Object.entries(data.agent || {}).map(([name, agent]) => ({
    name,
    description: agent.description,
    mode: agent.mode,
    builtIn: false,
  }));

  const names = new Set(configured.map((a) => a.name));
  const merged = [...DEFAULT_AGENTS.filter((a) => !names.has(a.name)), ...configured];

  res.json(merged);
});
