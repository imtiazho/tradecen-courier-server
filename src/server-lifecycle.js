function closeHttpServer(server) {
  const close = () => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") return reject(error);
      resolve();
    });
  });

  if (server.listening) return close();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    const onListening = () => {
      cleanup();
      close().then(resolve, reject);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
    if (server.listening) onListening();
  });
}

function waitUntilListening(server) {
  if (server.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
    if (server.listening) onListening();
  });
}

function createServerLifecycle({
  app,
  connectDB,
  closeDB,
  port,
  logger = console,
  processRef = process,
}) {
  let server;
  let shutdownRequested = false;
  let shutdownPromise;
  let closeDatabasePromise;

  function closeDatabaseOnce() {
    if (!closeDatabasePromise) closeDatabasePromise = Promise.resolve().then(closeDB);
    return closeDatabasePromise;
  }

  async function start() {
    if (shutdownRequested) return null;

    try {
      await connectDB();
    } catch (error) {
      try {
        await closeDatabaseOnce();
      } catch (closeError) {
        logger.error("Error closing MongoDB after startup failure:", closeError);
      }
      throw error;
    }

    if (shutdownRequested) {
      try {
        await closeDatabaseOnce();
        await closeDB();
      } catch (error) {
        logger.error("Error confirming MongoDB closure after startup shutdown:", error);
        processRef.exitCode = 1;
      }
      return null;
    }

    logger.log("🚀 MongoDB Connected");
    try {
      server = app.listen(port, "0.0.0.0", () => {
        logger.log(`Server running on port ${port}`);
      });
      server.keepAliveTimeout = 65000;
      server.headersTimeout = 66000;
      await waitUntilListening(server);
    } catch (error) {
      try {
        await closeDatabaseOnce();
      } catch (closeError) {
        logger.error("Error closing MongoDB after server startup failure:", closeError);
      }
      throw error;
    }
    if (shutdownRequested) return null;
    return server;
  }

  function shutdown(signal) {
    if (shutdownPromise) return shutdownPromise;
    shutdownRequested = true;
    logger.log(`${signal} received; shutting down`);

    shutdownPromise = (async () => {
      let shutdownFailed = false;
      try {
        if (server) await closeHttpServer(server);
      } catch (error) {
        shutdownFailed = true;
        logger.error("Error closing HTTP server:", error);
      }
      try {
        await closeDatabaseOnce();
      } catch (error) {
        shutdownFailed = true;
        logger.error("Error closing MongoDB:", error);
      }
      processRef.exitCode = shutdownFailed ? 1 : 0;
    })();

    return shutdownPromise;
  }

  return {
    start,
    shutdown,
    get shutdownRequested() {
      return shutdownRequested;
    },
  };
}

module.exports = createServerLifecycle;
