import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";

let serverHandle = null;
let client = null;

export async function startOpencode() {
  const hostname = process.env.OPENCODE_HOSTNAME || "127.0.0.1";
  const port = process.env.OPENCODE_PORT ? Number(process.env.OPENCODE_PORT) : 4096;
  const model = process.env.OPENCODE_MODEL || undefined;
  // OpenCode's own startup can be slow (e.g. it tries to refresh its model catalog over
  // the network) — the SDK's default 5s readiness timeout is too tight on a slow or
  // network-restricted host, so give it more room by default.
  const timeout = process.env.OPENCODE_STARTUP_TIMEOUT_MS ? Number(process.env.OPENCODE_STARTUP_TIMEOUT_MS) : 30000;

  serverHandle = await createOpencodeServer({
    hostname,
    port,
    timeout,
    config: model ? { model } : undefined,
  });

  client = createOpencodeClient({ baseUrl: serverHandle.url });
  return serverHandle;
}

export function getClient() {
  if (!client) {
    throw new Error("OpenCode client not initialized — call startOpencode() first");
  }
  return client;
}

export function stopOpencode() {
  serverHandle?.close();
}
