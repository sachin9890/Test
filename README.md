# opencode-remote

An Express API and web UI in front of an embedded [OpenCode](https://opencode.ai) server, so you can connect
a GitHub repo, start a coding session with a chosen model and agent, and watch it work — all from a browser,
from anywhere.

The Express app is the only thing meant to be reachable remotely. It runs an OpenCode server internally
(bound to `127.0.0.1`), and every session operates in its own isolated **git worktree** on its own branch,
so multiple concurrent sessions never collide on the same files.

## Setup

1. `npm install`
2. `cp .env.example .env` and set a strong `API_TOKEN`.
3. Make sure OpenCode's own model provider credentials are configured on this host (OpenCode reads its own
   auth/config — e.g. run `npx opencode-ai auth login` once, or drop in its config file). This app does not
   manage model provider API keys itself; it only lists whatever OpenCode already has configured.

Projects (the repos OpenCode works on) are added from the UI or API — see below — not by hand-cloning into
a fixed directory.

## Running

```bash
npm start   # or: npm run dev (auto-restart on changes)
```

The API listens on `HOST:PORT` (default `0.0.0.0:3000`). The embedded OpenCode server listens only on
`OPENCODE_HOSTNAME:OPENCODE_PORT` (default `127.0.0.1:4096`) and is never exposed directly.

If startup fails with `Timeout waiting for server to start`, OpenCode's own boot is likely slow (e.g. a
restricted network delaying its model-catalog refresh) — raise `OPENCODE_STARTUP_TIMEOUT_MS` in `.env`
(default `30000`).

## Web UI

Open `http://<host>:<port>/` in a browser (served from `public/`, no build step). Paste your `API_TOKEN` in
the top-right field and click **Save token** — it's kept in that browser's `localStorage` and sent only as
the `Authorization` header (except the live console stream, see the security note below).

- **Projects** — click **+ Add** to connect a repo: name, repo URL, optional branch, and an optional GitHub
  Personal Access Token for private repos. The app clones it server-side.
- **Sessions** — click **+ New**, pick a project, and optionally a title, an **agent** (a named OpenCode
  persona — e.g. `build` for full read/write, `plan` for read-only planning, or any custom agent the
  project's own OpenCode config defines), and a **model** from whatever providers are configured on this
  host. Both become that session's defaults for every message it sends.
- **Task** — the main tab, a 4-step workflow instead of open-ended chat:
  1. **Describe** what you want done, in plain English.
  2. OpenCode proposes a **plan** using its read-only `plan` agent — nothing is touched yet.
  3. **Accept & implement** or **Reject**. Accepting re-runs the same request through a write-capable agent
     (the session's own agent, or `build` if the session's default is itself `plan`) and switches to a live,
     streaming view of what's actually happening — tool calls, file edits, status — while it works.
  4. **Done** — see the result, jump to **Diff**, or start another task on the same session.
- **Console** — the same live event stream as a standalone tab, so you can watch a session's activity at any
  time, not just right after accepting a plan.
- **Status** / **Diff** — the session worktree's real `git status` / `git diff`.
- **Setup** — read-only: exactly what this session sees — built-ins, whatever the project's repo has, and
  anything added at creation time.
- **⚙ on a project** — add custom skills, agents, or commands, in OpenCode's own format (see below).

### Skills, agents & commands

These work exactly like the OpenCode CLI's own — a skill/agent/command is just a markdown file with
frontmatter under `.opencode/`, and OpenCode auto-discovers whatever's in a directory when it starts working
there. This app gives you two places to add one, matching how OpenCode actually loads them:

- **Project-level** (the project's ⚙ button) — written into the project's own repo and committed there, so
  every session created *after that point* inherits it (a new session's worktree is checked out from the
  project's current commit). Sessions that already exist won't see it retroactively.
- **Session-level** (the "add for this session only" section in the New Session dialog) — written straight
  into that one session's worktree, before the session is created.

Both land in the same place OpenCode itself would look: `.opencode/skills/<name>/SKILL.md` for skills,
`.opencode/agent/<name>.md` for agents, `.opencode/command/<name>.md` for commands.

One real constraint worth knowing, found by testing against a running OpenCode server directly: it caches
what it discovers in a directory for the life of its process — with no live invalidation. A brand-new
directory (a session's fresh worktree) always reflects what's on disk correctly the first time it's queried,
but adding a file to a directory OpenCode has *already* looked at won't be picked up until the whole app
restarts. That's why session-level additions are only offered at session-creation time (before OpenCode ever
sees that worktree) rather than as an "add anytime" action on an existing session — the latter would silently
not work.

MCP servers and plugins are deliberately not exposed here: a plugin is a JS/TS module the server would
`import()` and execute, and an MCP server spawns an arbitrary subprocess or calls an arbitrary remote
endpoint — accepting those from the same UI/API surface a remote user's API token can reach would mean
anyone with that token gets code execution on the host.

## How it works

**Projects** (`POST /api/projects`) are cloned into `PROJECTS_DIR/<projectId>`. If a PAT is given, it's
stored server-side (`DATA_DIR/projects.json`, 0600 permissions, git-ignored) and injected as an
`Authorization: Basic` header on clone/pull only — never written into `.git/config`, the remote URL, or any
API response.

**Sessions** (`POST /api/sessions`) each get their own checkout under `WORKTREES_DIR/<projectId>/<sessionId>`,
on branch `session/<sessionId>`, created off that project's clone. OpenCode reads and edits files there —
real changes, not a simulation. This app never commits, merges, or pushes anything on its own; reviewing and
merging a session's branch is always a manual step you do yourself on the host, e.g.:

```bash
git -C projects/<projectId> fetch
git -C projects/<projectId> checkout session/<sessionId>
```

Typical flow: add a project → create a session (project + agent + model) → send it a coding task → watch
the **Console** tab or poll **Diff** → review/merge the branch yourself → delete the session
(`DELETE /api/sessions/:id`, add `?force=true` to discard uncommitted changes) when done. Deleting a project
is blocked while it still has sessions, so nothing is silently orphaned.

## API reference

All routes below require `Authorization: Bearer <API_TOKEN>` (the events route also accepts `?token=`, see
security notes). `/health` does not require auth.

| Method | Path                             | Description                                                                 |
| ------ | -------------------------------- | ---------------------------------------------------------------------------- |
| GET    | `/health`                        | Liveness check, no auth required.                                          |
| GET    | `/api/projects`                  | List projects (repo URL, branch, whether a PAT is set — never the PAT itself). |
| POST   | `/api/projects`                  | Add + clone a project: `{ name, repoUrl, branch?, pat? }`.                  |
| POST   | `/api/projects/:id/pull`         | Fast-forward pull the project's default branch.                            |
| DELETE | `/api/projects/:id`              | Delete a project (fails with 409 if it still has sessions).                |
| GET    | `/api/projects/:id/customizations` | List this project's own skills/agents/commands (not built-ins/globals).  |
| POST   | `/api/projects/:id/customizations` | Add one, committed to the project's repo: `{ type, name, description, body, ... }`. |
| DELETE | `/api/projects/:id/customizations/:type/:name` | Remove one, committed to the project's repo.                |
| GET    | `/api/meta/providers`            | Model providers/models actually configured on this host.                   |
| GET    | `/api/meta/agents`               | Available agents (built-in `build`/`plan` plus any the project defines).   |
| POST   | `/api/sessions`                  | Create a session: `{ projectId, title?, agent?, model?, customizations? }` (`model` is `{ providerID, modelID }`; `customizations` is an array of `{ type, name, description, body, ... }`, applied to this session only, before it's created). |
| GET    | `/api/sessions`                  | List active sessions with their project/worktree/branch info.              |
| DELETE | `/api/sessions/:id`              | Delete a session + worktree. `?force=true` discards uncommitted changes.   |
| GET    | `/api/sessions/:id/messages`     | Get the session's message history.                                        |
| POST   | `/api/sessions/:id/messages`     | Send a prompt: `{ text, agent?, model? }` (defaults to the session's).     |
| GET    | `/api/sessions/:id/status`       | `git status --porcelain` for the session's worktree.                      |
| GET    | `/api/sessions/:id/diff`         | `git diff` for the session's worktree.                                    |
| GET    | `/api/sessions/:id/events`       | Server-Sent Events stream of that session's live OpenCode activity.       |
| GET    | `/api/sessions/:id/customizations` | What this session actually sees: built-ins + project's + its own one-off ones. |

### Example

```bash
API=http://localhost:3000
TOKEN=change-me

# Add a project
PROJECT=$(curl -s -X POST "$API/api/projects" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"My app","repoUrl":"https://github.com/me/my-app.git","pat":"ghp_..."}')
PROJECT_ID=$(echo "$PROJECT" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

# Create a session
SESSION=$(curl -s -X POST "$API/api/sessions" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"projectId\":\"$PROJECT_ID\",\"agent\":\"build\"}")
ID=$(echo "$SESSION" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

# Ask it to do something
curl -s -X POST "$API/api/sessions/$ID/messages" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"add a README badge for the license"}'

# See what it changed
curl -s "$API/api/sessions/$ID/diff" -H "Authorization: Bearer $TOKEN"
```

## Remote access security notes

- Only bind `HOST=0.0.0.0` behind HTTPS — put a reverse proxy (Caddy, Nginx) or a tunnel (SSH, Cloudflare
  Tunnel) in front of it. This app does not terminate TLS itself.
- Always set a strong, random `API_TOKEN`. There is no other authentication, and no per-user accounts —
  anyone with the token has full control over every project and session.
- Never expose `OPENCODE_PORT` (default `4096`) to the network — the embedded OpenCode server has no auth
  of its own and is only meant to be reached from this app, on `localhost`.
- Browsers' native `EventSource` can't set custom headers, so `/api/sessions/:id/events` also accepts the
  token as `?token=...`. That's the one endpoint where the token can end up in server access logs — a
  documented tradeoff for the live console. Every other route only accepts the `Authorization` header.
- GitHub PATs are stored server-side in `DATA_DIR/projects.json` (0600 permissions, git-ignored) and are
  never returned by any API response. Anyone with filesystem access to that host can still read them, same
  as any other locally-stored credential.
