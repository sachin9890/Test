import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as git from "./git.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { getClient, startOpencode, stopOpencode } from "./opencode.js";
import * as projects from "./projects.js";
import { metaRouter } from "./routes/meta.js";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

// A crash (as opposed to a graceful SIGINT/SIGTERM shutdown) skips the `shutdown()`
// handler below entirely, leaving the embedded OpenCode server as an orphaned child
// still holding its port — every restart after that fails to bind until someone finds
// and kills it by hand. Covering these two paths too is what makes a crash self-heal
// (nodemon restarts into a free port) instead of wedging the app until manual cleanup.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  stopOpencode();
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  stopOpencode();
  process.exit(1);
});

async function main() {
  if (!process.env.API_TOKEN) {
    console.error("API_TOKEN environment variable is required.");
    process.exit(1);
  }

  await git.ensureWorktreesDir();
  await projects.loadProjects();
  await git.loadSessions();

  const opencodeServer = await startOpencode();
  getClient(); // fail fast if the client didn't initialize
  console.log(`OpenCode server running at ${opencodeServer.url}`);

  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use("/api/projects", authMiddleware, projectsRouter);
  app.use("/api/meta", authMiddleware, metaRouter);
  app.use("/api/sessions", authMiddleware, sessionsRouter);
  // Never let a browser (or intermediary proxy) cache the UI — this is a small internal
  // tool, not a CDN-fronted app, and "why isn't my change showing" is worse than the
  // negligible cost of a fresh fetch each load.
  app.use(
    express.static(publicDir, {
      setHeaders: (res) => res.set("Cache-Control", "no-store"),
    }),
  );
  app.use(errorHandler);

  const host = process.env.HOST || "0.0.0.0";
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  const server = app.listen(port, host, () => {
    console.log(`API listening on http://${host}:${port}`);
  });

  const shutdown = () => {
    console.log("Shutting down...");
    server.close(() => {
      stopOpencode();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
