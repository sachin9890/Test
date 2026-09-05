import { getClient } from "./opencode.js";

// Events worth showing in a "live coding progress" console. OpenCode's directory-scoped
// stream also carries provider/plugin catalog bookkeeping (plugin.added, catalog.updated,
// etc.) that's irrelevant noise here, so only these types are forwarded.
const RELEVANT_TYPES = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.removed",
  "session.status",
  "session.idle",
  "session.error",
  "session.diff",
  "file.edited",
  "permission.updated",
  "todo.updated",
]);

// OpenCode's /event stream is scoped by the `directory` query param — subscribing with
// no directory yields almost nothing. Since every session has its own unique worktree
// directory, subscribing per-session (rather than one global feed fanned out) is both
// necessary and sufficient: no cross-session filtering needed, OpenCode already scopes it.
export async function streamSessionEvents(record, onEvent, signal) {
  const client = getClient();
  const result = await client.event.subscribe({ query: { directory: record.path }, signal });
  for await (const event of result.stream) {
    if (RELEVANT_TYPES.has(event.type)) onEvent(event);
  }
}
