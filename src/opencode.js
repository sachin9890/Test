import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";

let serverHandle = null;
let client = null;

export async function startOpencode() {
  const hostname = process.env.OPENCODE_HOSTNAME || "127.0.0.1";
  const port = process.env.OPENCODE_PORT ? Number(process.env.OPENCODE_PORT) : 4096;
  const model = process.env.OPENCODE_MODEL || undefined;

  serverHandle = await createOpencodeServer({
    hostname,
    port,
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
