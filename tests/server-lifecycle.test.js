const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const createServerLifecycle = require("../src/server-lifecycle");

const silentLogger = { log() {}, error() {} };

test("shutdown during a pending MongoDB connection prevents the server from listening", async () => {
  let finishConnection;
  let listenCount = 0;
  let closeDatabaseCount = 0;
  const processRef = {};
  const lifecycle = createServerLifecycle({
    app: { listen() { listenCount += 1; throw new Error("must not listen"); } },
    connectDB: () => new Promise((resolve) => { finishConnection = resolve; }),
    closeDB: async () => { closeDatabaseCount += 1; },
    port: 5000,
    logger: silentLogger,
    processRef,
  });

  const startup = lifecycle.start();
  const shutdown = lifecycle.shutdown("SIGTERM");
  await shutdown;
  finishConnection();
  assert.equal(await startup, null);

  assert.equal(listenCount, 0);
  assert.equal(closeDatabaseCount, 2);
  assert.equal(processRef.exitCode, 0);
});

test("normal startup listens once and duplicate shutdown closes server and database once", async () => {
  let listenCount = 0;
  let serverCloseCount = 0;
  let databaseCloseCount = 0;
  const processRef = {};
  const app = {
    listen(port, host, callback) {
      listenCount += 1;
      const server = new EventEmitter();
      server.listening = true;
      server.close = (done) => {
        serverCloseCount += 1;
        server.listening = false;
        done();
      };
      server.port = port;
      server.host = host;
      callback();
      return server;
    },
  };
  const lifecycle = createServerLifecycle({
    app,
    connectDB: async () => {},
    closeDB: async () => { databaseCloseCount += 1; },
    port: 5000,
    logger: silentLogger,
    processRef,
  });

  const server = await lifecycle.start();
  assert.equal(server.port, 5000);
  assert.equal(server.keepAliveTimeout, 65000);
  assert.equal(server.headersTimeout, 66000);
  assert.equal(listenCount, 1);

  const firstShutdown = lifecycle.shutdown("SIGINT");
  const secondShutdown = lifecycle.shutdown("SIGTERM");
  assert.equal(firstShutdown, secondShutdown);
  await firstShutdown;

  assert.equal(serverCloseCount, 1);
  assert.equal(databaseCloseCount, 1);
  assert.equal(processRef.exitCode, 0);
});

test("startup connection failure closes MongoDB and rejects startup", async () => {
  let databaseCloseCount = 0;
  const lifecycle = createServerLifecycle({
    app: { listen() { throw new Error("must not listen"); } },
    connectDB: async () => { throw new Error("connection failed"); },
    closeDB: async () => { databaseCloseCount += 1; },
    port: 5000,
    logger: silentLogger,
    processRef: {},
  });

  await assert.rejects(lifecycle.start(), /connection failed/);
  assert.equal(databaseCloseCount, 1);
});

test("listen failure closes MongoDB and rejects startup", async () => {
  let databaseCloseCount = 0;
  const app = {
    listen() {
      const server = new EventEmitter();
      server.listening = false;
      queueMicrotask(() => server.emit("error", new Error("port is unavailable")));
      return server;
    },
  };
  const lifecycle = createServerLifecycle({
    app,
    connectDB: async () => {},
    closeDB: async () => { databaseCloseCount += 1; },
    port: 5000,
    logger: silentLogger,
    processRef: {},
  });

  await assert.rejects(lifecycle.start(), /port is unavailable/);
  assert.equal(databaseCloseCount, 1);
});

test("shutdown still closes MongoDB when closing the HTTP server fails", async () => {
  let databaseCloseCount = 0;
  const processRef = {};
  const app = {
    listen(port, host, callback) {
      const server = new EventEmitter();
      server.listening = true;
      server.close = (done) => done(new Error("mock server close failure"));
      callback();
      return server;
    },
  };
  const lifecycle = createServerLifecycle({
    app,
    connectDB: async () => {},
    closeDB: async () => { databaseCloseCount += 1; },
    port: 5000,
    logger: silentLogger,
    processRef,
  });

  await lifecycle.start();
  await lifecycle.shutdown("SIGTERM");
  assert.equal(databaseCloseCount, 1);
  assert.equal(processRef.exitCode, 1);
});
