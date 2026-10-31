const assert = require("node:assert/strict");
const express = require("express");
const { test } = require("node:test");

const createRouteDependencies = require("../src/routes/dependencies");
const createPayoutsRouter = require("../src/routes/payouts");

function cursor(items = []) {
  return {
    limit() { return this; },
    sort() { return this; },
    toArray: async () => items,
  };
}

function makeSecurityHarness(users = {}) {
  // The dependency factory initializes Stripe; this test uses a synthetic key
  // and never reads credentials from the developer environment.
  process.env.STRIPE_SECRET = "sk_test_security_suite_placeholder";

  const admin = {
    auth: () => ({
      verifyIdToken: async (token) => {
        if (token === "bad") throw new Error("invalid token");
        const email = { merchant: "merchant@example.test", rider: "rider@example.test" }[token];
        if (!email) throw new Error("unknown token");
        return { email };
      },
    }),
  };
  const collections = {
    userCollections: { findOne: async ({ email }) => users[email] || null },
    parcelsCollections: { find: () => cursor([]) },
    payoutsCollections: { find: () => cursor([]) },
  };
  const dependencies = createRouteDependencies({
    admin,
    connectDB: async () => collections,
    withTransaction: async (callback) => callback({}),
  });
  delete process.env.STRIPE_SECRET;

  const app = express();
  const router = createPayoutsRouter(dependencies);
  app.use(router);
  return { app, router, collections, dependencies };
}

function closeCaches(dependencies) {
  for (const value of Object.values(dependencies)) {
    if (typeof value?.close === "function") value.close();
    if (typeof value?.store?.close === "function") value.store.close();
  }
}

async function request(router, method, path, authorization, body = {}, params = {}) {
  const routeLayer = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(routeLayer, `${method.toUpperCase()} ${path} exists`);
  const route = routeLayer.route;
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
  };
  const req = {
    method: method.toUpperCase(),
    headers: authorization ? { authorization } : {},
    params,
    query: {},
    body,
  };
  for (const layer of route.stack) {
    let nextCalled = false;
    await new Promise((resolve, reject) => {
      const next = (error) => {
        if (error) return reject(error);
        nextCalled = true;
        resolve();
      };
      try {
        const result = layer.handle(req, response, next);
        if (result && typeof result.then === "function") {
          result.then(() => {
            if (!nextCalled && Object.hasOwn(response, "body")) resolve();
          }, reject);
        } else if (!nextCalled && Object.hasOwn(response, "body")) {
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
    if (Object.hasOwn(response, "body")) break;
  }
  return response;
}

test("merchant payout summary rejects unauthenticated and invalid Firebase tokens", async () => {
  const { router, dependencies } = makeSecurityHarness({ "merchant@example.test": { role: "merchant" } });
  try {
    const missing = await request(router, "get", "/payment-payout-summary/:email", undefined, {}, { email: "merchant@example.test" });
    assert.equal(missing.statusCode, 401);

    const invalid = await request(router, "get", "/payment-payout-summary/:email", "Bearer bad", {}, { email: "merchant@example.test" });
    assert.equal(invalid.statusCode, 401);
  } finally {
    closeCaches(dependencies);
  }
});

test("merchant payout summary enforces merchant role and account ownership", async () => {
  const { router, dependencies } = makeSecurityHarness({
    "merchant@example.test": { role: "merchant" },
    "rider@example.test": { role: "rider" },
  });
  try {
    const insufficientRole = await request(router, "get", "/payment-payout-summary/:email", "Bearer rider", {}, { email: "merchant@example.test" });
    assert.equal(insufficientRole.statusCode, 403);

  const crossUser = await request(
    router,
    "get",
    "/payment-payout-summary/:email",
    "Bearer merchant",
    {},
    { email: "someone-else@example.test" },
  );
    assert.equal(crossUser.statusCode, 403);

    const authorized = await request(router, "get", "/payment-payout-summary/:email", "Bearer merchant", {}, { email: "merchant@example.test" });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.body.success, true);
  } finally {
    closeCaches(dependencies);
  }
});

test("payout requests require an authenticated merchant acting for their own account", async () => {
  const { router, dependencies } = makeSecurityHarness({
    "merchant@example.test": { role: "merchant" },
    "rider@example.test": { role: "rider" },
  });
  try {
    const missing = await request(router, "post", "/request-payout", undefined, {
      email: "merchant@example.test", withdrawAmount: 1,
    });
    assert.equal(missing.statusCode, 401);

    const insufficientRole = await request(router, "post", "/request-payout", "Bearer rider", {
      email: "rider@example.test", withdrawAmount: 1,
    });
    assert.equal(insufficientRole.statusCode, 403);

    const crossUser = await request(router, "post", "/request-payout", "Bearer merchant", {
      email: "other@example.test", withdrawAmount: 1,
    });
    assert.equal(crossUser.statusCode, 403);

    const authorized = await request(router, "post", "/request-payout", "Bearer merchant", {
      email: "merchant@example.test", withdrawAmount: 1,
    });
    assert.equal(authorized.statusCode, 400);
    assert.match(authorized.body.message, /Insufficient balance/);
  } finally {
    closeCaches(dependencies);
  }
});
