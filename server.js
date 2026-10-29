// This must be set before loading application dependencies, as in the legacy entry point.
process.env.UV_THREADPOOL_SIZE = 128;

const app = require("./index");
const { connectDB, closeDB } = require("./src/config/database");

const port = process.env.PORT || 5000;
let server;
let shuttingDown = false;

async function start() {
  await connectDB();
  console.log("🚀 MongoDB Connected");

  server = app.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down`);

  try {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await closeDB();
    process.exitCode = 0;
  } catch (error) {
    console.error("Error during server shutdown:", error);
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((error) => {
  console.error("❌ DB connection failed:", error);
  process.exitCode = 1;
});
