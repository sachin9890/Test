import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./httpError.js";
import { getServerUrl } from "./opencode.js";

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function validateName(name) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      'name must be lowercase, start with a letter, and contain only letters/digits/hyphens (matches OpenCode\'s own naming rule, e.g. "my-skill")',
    );
  }
}

function frontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null || v === "") continue;
        lines.push(`  ${k}: ${v}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

// Each type mirrors exactly how OpenCode itself loads these from disk (see its
// built-in "customize-opencode" skill / https://opencode.ai/config.json): a
// name/description + markdown body, at a fixed path under .opencode/.
const TYPES = {
  skill: {
    apiPath: "skill",
    relPath: (name) => path.join(".opencode", "skills", name, "SKILL.md"),
    render: ({ name, description, body }) => frontmatter({ name, description }) + (body || "").trim() + "\n",
  },
  agent: {
    apiPath: "agent",
    relPath: (name) => path.join(".opencode", "agent", `${name}.md`),
    render: ({ description, mode, editPermission, body }) =>
      frontmatter({ description, mode: mode || "primary", permission: { edit: editPermission || "ask" } }) +
      (body || "").trim() +
      "\n",
  },
  command: {
    apiPath: "command",
    relPath: (name) => path.join(".opencode", "command", `${name}.md`),
    render: ({ description, agent, body }) => frontmatter({ description, agent }) + (body || "").trim() + "\n",
  },
};

function typeConfig(type) {
  const cfg = TYPES[type];
  if (!cfg) {
    throw new HttpError(400, `type must be one of: ${Object.keys(TYPES).join(", ")}`);
  }
  return cfg;
}

// Reflects exactly what OpenCode itself would resolve for this directory — built-ins,
// whatever's committed in the repo, and anything just written here, all merged the same
// way a real "opencode" CLI run in that directory would see them.
//
// Caveat, found by testing against a real server: OpenCode caches what it discovers in
// a directory for the life of its process — querying this once "poisons" that directory
// forever after, so anything added later never shows up here again without a server
// restart, even though it's correctly on disk and correctly picked up by any *new*
// session (which always queries a brand-new, never-before-seen worktree path). That
// makes this call fine for a one-shot "what does this session actually see" read (see
// GET /api/sessions/:id/customizations), but wrong for a management view that lists,
// lets you add, and re-lists — use listOwnCustomizations for that instead.
export async function listCustomizations(directory) {
  const result = {};
  for (const [type, cfg] of Object.entries(TYPES)) {
    const url = `${getServerUrl()}/api/${cfg.apiPath}?${new URLSearchParams({ "location[directory]": directory })}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new HttpError(502, `Failed to list ${type}s from OpenCode`, await res.text());
    }
    const { data } = await res.json();
    result[type] = data
      .filter((item) => !item.hidden)
      .map((item) => ({
        name: item.name || item.id,
        description: item.description,
        location: item.location,
      }));
  }
  return result;
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

function frontmatterField(content, field) {
  const match = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

// Reads only what THIS app has written under directory/.opencode/ — always accurate
// (no server-side caching to worry about), but doesn't include built-ins or anything
// global/inherited from elsewhere. Used by the project management view.
export async function listOwnCustomizations(directory) {
  const result = { skill: [], agent: [], command: [] };

  for (const name of await fs.readdir(path.join(directory, ".opencode", "skills")).catch(() => [])) {
    const rel = path.join(".opencode", "skills", name, "SKILL.md");
    const content = await readIfExists(path.join(directory, rel));
    if (content === null) continue;
    result.skill.push({ name: frontmatterField(content, "name") || name, description: frontmatterField(content, "description"), location: rel });
  }

  for (const type of ["agent", "command"]) {
    for (const file of await fs.readdir(path.join(directory, ".opencode", type)).catch(() => [])) {
      if (!file.endsWith(".md")) continue;
      const rel = path.join(".opencode", type, file);
      const content = await fs.readFile(path.join(directory, rel), "utf8");
      result[type].push({ name: file.replace(/\.md$/, ""), description: frontmatterField(content, "description"), location: rel });
    }
  }

  return result;
}

export async function addCustomization(directory, type, fields) {
  const cfg = typeConfig(type);
  validateName(fields.name);
  if (!fields.description) {
    throw new HttpError(400, "description is required");
  }

  const relPath = cfg.relPath(fields.name);
  const absPath = path.join(directory, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, cfg.render(fields));

  return { type, name: fields.name, description: fields.description, path: relPath };
}

export async function removeCustomization(directory, type, name) {
  const cfg = typeConfig(type);
  validateName(name);
  const absPath = path.join(directory, cfg.relPath(name));

  try {
    await fs.unlink(absPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new HttpError(404, `No ${type} named "${name}" found here`);
    }
    throw err;
  }

  if (type === "skill") {
    await fs.rmdir(path.dirname(absPath)).catch(() => {});
  }
}
