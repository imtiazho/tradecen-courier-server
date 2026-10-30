// This must be set before loading application dependencies, as in the legacy entry point.
process.env.UV_THREADPOOL_SIZE = 128;

const app = require("./index");
const { connectDB, closeDB } = require("./src/config/database");
const createServerLifecycle = require("./src/server-lifecycle");

const port = process.env.PORT || 5000;
const lifecycle = createServerLifecycle({ app, connectDB, closeDB, port });

process.on("SIGINT", () => lifecycle.shutdown("SIGINT"));
process.on("SIGTERM", () => lifecycle.shutdown("SIGTERM"));

lifecycle.start().catch((error) => {
  if (lifecycle.shutdownRequested) return;
  console.error("❌ Server startup failed:", error);
  process.exitCode = 1;
});
