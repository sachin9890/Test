# opencode-remote

An Express API in front of an embedded [OpenCode](https://opencode.ai) server, so you can drive real coding
sessions against a project from anywhere — not just a local terminal.

The Express app is the only thing meant to be reachable remotely. It runs an OpenCode server internally
(bound to `127.0.0.1`), and every session it creates operates in its own isolated **git worktree** on its
own branch, so multiple concurrent remote sessions never collide on the same files.

## Setup

1. `npm install`
2. `cp .env.example .env` and set a strong `API_TOKEN`.
3. Make sure OpenCode's own provider credentials are configured on this host (OpenCode reads its own
   auth/config — e.g. run `npx opencode-ai auth login` once, or drop in its config file). This app does not
   manage model provider API keys itself.
4. Clone the project you want OpenCode to work on into `REPO_DIR` (default `./repo`). It must already have
   at least one commit — `git worktree` can't branch off an empty repo.

```bash
git clone <your-project-url> repo
```

## Running

```bash
npm start   # or: npm run dev (auto-restart on changes)
```

The API listens on `HOST:PORT` (default `0.0.0.0:3000`). The embedded OpenCode server listens only on
`OPENCODE_HOSTNAME:OPENCODE_PORT` (default `127.0.0.1:4096`) and is never exposed directly.

## How sessions work

Every session gets its own checkout under `WORKTREES_DIR/<sessionId>`, on branch `session/<sessionId>`,
created off `REPO_DIR`. OpenCode reads and edits files there — real file changes, not a simulation. This
app never commits, merges, or pushes anything on its own; reviewing and merging a session's branch is
always a manual step you do yourself on the host.

Typical flow:

1. `POST /api/sessions` — creates a worktree + branch and an OpenCode session pointed at it.
2. `POST /api/sessions/:id/messages` — send it a coding task in plain English.
3. `GET /api/sessions/:id/diff` — see exactly what it changed.
4. From the host: `git -C repo fetch` / `git -C repo checkout session/<id>` to review, then merge and push
   yourself once you're happy.
5. `DELETE /api/sessions/:id` — clean up the worktree when you're done with it.

## API reference

All `/api/sessions*` routes require `Authorization: Bearer <API_TOKEN>`. `/health` does not.

| Method | Path                        | Description                                                              |
| ------ | --------------------------- | ------------------------------------------------------------------------- |
| GET    | `/health`                   | Liveness check, no auth required.                                       |
| POST   | `/api/sessions`             | Create a session (optional JSON body: `{ "title": "..." }`).             |
| GET    | `/api/sessions`             | List active sessions and their worktree/branch info.                    |
| DELETE | `/api/sessions/:id`         | Delete a session and its worktree. Add `?force=true` to discard uncommitted changes. |
| GET    | `/api/sessions/:id/messages`| Get the session's message history.                                      |
| POST   | `/api/sessions/:id/messages`| Send a prompt (JSON body: `{ "text": "..." }`) and get the reply.        |
| GET    | `/api/sessions/:id/status`  | `git status --porcelain` output for the session's worktree.             |
| GET    | `/api/sessions/:id/diff`    | `git diff` output for the session's worktree.                           |

### Example

```bash
API=http://localhost:3000
TOKEN=change-me

# Create a session
SESSION=$(curl -s -X POST "$API/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}')
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
- Always set a strong, random `API_TOKEN`. There is no other authentication.
- Never expose `OPENCODE_PORT` (default `4096`) to the network — the embedded OpenCode server has no auth
  of its own and is only meant to be reached from this app, on `localhost`.
