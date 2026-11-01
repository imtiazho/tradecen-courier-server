const assert = require("node:assert/strict");
const express = require("express");
const { ObjectId } = require("mongodb");
const { test } = require("node:test");

const createRouteDependencies = require("../src/routes/dependencies");
const createUsersRouter = require("../src/routes/users");
const createHubParcelsRouter = require("../src/routes/hub-parcels");
const createMerchantsRouter = require("../src/routes/merchants");
const createParcelQueriesRouter = require("../src/routes/parcel-queries");
const createOtpRouter = require("../src/routes/otp");
const createPaymentsRouter = require("../src/routes/payments");

const parcelId = "0123456789abcdef01234567";

function cursor(items = []) {
  return { sort() { return this; }, limit() { return this; }, skip() { return this; }, project() { return this; }, toArray: async () => items };
}

function makeHarness() {
  process.env.STRIPE_SECRET = "sk_test_placeholder_security_hardening";
  const users = new Map([
    ["merchant@example.test", { email: "merchant@example.test", role: "merchant" }],
    ["admin@example.test", { email: "admin@example.test", role: "admin" }],
    ["other@example.test", { email: "other@example.test", role: "merchant" }],
    ["manager-a@example.test", { email: "manager-a@example.test", role: "hub-manager" }],
    ["manager-b@example.test", { email: "manager-b@example.test", role: "hub-manager" }],
  ]);
  const hubManagers = new Map([
    ["manager-a@example.test", { email: "manager-a@example.test", hubName: "A" }],
    ["manager-b@example.test", { email: "manager-b@example.test", hubName: "B" }],
  ]);
  const otpRecords = new Map();
  const updateCalls = [];
  const merchantUpdateCalls = [];
  const parcel = {
    _id: new ObjectId(parcelId), deliveryCharge: 49.95, deliveryChargeStatus: "unpaid",
    trackingID: "TRACK-1", parcelName: "Box", senderInfo: { email: "merchant@example.test", name: "Sender" },
    receiverInfo: { name: "Receiver" },
    serviceCenters: { origin: "A", destination: "B" },
  };
  const parcels = new Map([[parcelId, parcel]]);
  const paymentRows = new Map();
  let checkoutPayload;
  const sentMessages = [];

  const userCollections = {
    findOne: async ({ email }) => users.get(email) || null,
    find: () => cursor([...users.values()]),
    updateOne: async (filter, update) => {
      updateCalls.push({ filter, update });
      const doc = users.get(filter.email);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    insertOne: async (user) => { users.set(user.email, user); return { insertedId: "user-id" }; },
  };
  const parcelsCollections = {
    findOne: async (filter) => parcels.get(String(filter._id)) || null,
    find: () => cursor([]),
    countDocuments: async () => 0,
    insertOne: async () => ({ insertedId: "parcel-new" }),
    deleteOne: async (filter) => ({ deletedCount: parcels.delete(String(filter._id)) ? 1 : 0 }),
    updateOne: async (filter, update) => {
      const stored = parcels.get(String(filter._id));
      if (!stored || stored.deliveryChargeStatus === "paid") return { matchedCount: 0, modifiedCount: 0 };
      for (const [key, value] of Object.entries(filter)) {
        if (key.startsWith("serviceCenters.") && stored.serviceCenters?.[key.split(".")[1]] !== value) {
          return { matchedCount: 0, modifiedCount: 0 };
        }
      }
      Object.assign(stored, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const paymentCollections = {
    findOne: async ({ transactionId }) => paymentRows.get(transactionId) || null,
    insertOne: async (row) => { paymentRows.set(row.transactionId, row); return { insertedId: "payment-id" }; },
  };
  const merchantsCollections = {
    find: () => cursor([{ email: "merchant@example.test", area: "A" }]),
    findOne: async () => null,
    insertOne: async () => ({ insertedId: "merchant-id" }),
    updateOne: async (filter, update) => {
      merchantUpdateCalls.push({ filter, update });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const admin = {
    auth: () => ({
      verifyIdToken: async (token) => {
        if (token === "expired" || token === "invalid") throw new Error("rejected");
        const email = {
          merchant: "merchant@example.test",
          admin: "admin@example.test",
          other: "other@example.test",
          managerA: "manager-a@example.test",
          managerB: "manager-b@example.test",
        }[token];
        if (!email) throw new Error("rejected");
        return { email };
      },
      getUserByEmail: async () => ({ uid: "firebase-user" }),
      updateUser: async () => ({}),
    }),
    firestore: () => ({
      collection: () => ({
        doc: (email) => ({
          get: async () => ({ exists: otpRecords.has(email), data: () => otpRecords.get(email) }),
          set: async (data, options) => otpRecords.set(email, options?.merge ? { ...otpRecords.get(email), ...data } : data),
          delete: async () => otpRecords.delete(email),
        }),
      }),
      runTransaction: async (callback) => callback({
        get: async (doc) => doc.get(),
        set: (doc, data, options) => doc.set(data, options),
      }),
    }),
  };
  const deps = createRouteDependencies({
    admin,
    connectDB: async () => ({ userCollections, parcelsCollections, paymentCollections,
      merchantsCollections,
      hubManagersCollection: {
        find: (query = {}) => cursor([...hubManagers.values()].filter((manager) =>
          Object.entries(query).every(([key, value]) => manager[key] === value))),
        findOne: async (query) => [...hubManagers.values()].find((manager) =>
          Object.entries(query).every(([key, value]) => manager[key] === value)) || null,
      },
      trackingLogsCollections: { find: () => cursor([]), insertOne: async () => ({ insertedId: "tracking-id" }) } }),
    withTransaction: async (callback) => callback({}),
  });
  deps.stripe.checkout.sessions.create = async (payload) => {
    checkoutPayload = payload;
    return { url: "https://checkout.invalid" };
  };
  deps.stripe.checkout.sessions.retrieve = async () => ({
    payment_intent: "pi-1", payment_status: "paid", mode: "payment", currency: "usd",
    metadata: { parcelId, trackingID: "TRACK-1", percelName: "Box" },
    amount_total: 4995, customer_email: "merchant@example.test",
  });
  deps.transporter.sendMail = async (message) => { sentMessages.push(message); return {}; };
  const app = express();
  app.use(express.json());
  app.use(createUsersRouter(deps));
  app.use(createHubParcelsRouter(deps));
  app.use(createMerchantsRouter(deps));
  app.use(createParcelQueriesRouter(deps));
  app.use(createOtpRouter(deps));
  app.use(createPaymentsRouter(deps));
  delete process.env.STRIPE_SECRET;
  return { app, deps, users, hubManagers, otpRecords, parcel, parcels, updateCalls, merchantUpdateCalls, paymentRows, sentMessages, getCheckoutPayload: () => checkoutPayload };
}

function closeCaches(deps) {
  for (const value of Object.values(deps)) {
    if (typeof value?.close === "function") value.close();
    if (typeof value?.store?.close === "function") value.store.close();
  }
}

function findRoute(app, method, routePath) {
  for (const layer of app.router.stack) {
    const stack = layer.handle?.stack || [];
    const routeLayer = stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method]);
    if (routeLayer) return routeLayer.route;
  }
  throw new Error(`${method} ${routePath} not found`);
}

async function request(route, { token, params = {}, query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(bodyValue) { this.body = bodyValue; return this; },
    setHeader() {},
  };
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, params, query, body };
  for (const layer of route.stack) {
    let nextCalled = false;
    let settle;
    const pending = new Promise((resolve, reject) => {
      settle = resolve;
      try {
        const result = layer.handle(req, res, (error) => {
          if (error) return reject(error);
          nextCalled = true;
          resolve();
        });
        if (result?.then) result.then(() => {
          if (!nextCalled && Object.hasOwn(res, "body")) resolve();
        }, reject);
        else if (!nextCalled && Object.hasOwn(res, "body")) resolve();
      } catch (error) { reject(error); }
    });
    const originalSend = res.send.bind(res);
    res.send = (value) => { originalSend(value); settle(); return res; };
    await pending;
    if (Object.hasOwn(res, "body")) break;
  }
  return res;
}

test("user data routes reject unauthenticated, invalid, expired and cross-account access", async () => {
  const h = makeHarness();
  try {
    const route = findRoute(h.app, "get", "/user/:email");
    assert.equal((await request(route, { params: { email: "merchant@example.test" } })).statusCode, 401);
    assert.equal((await request(route, { token: "invalid", params: { email: "merchant@example.test" } })).statusCode, 401);
    assert.equal((await request(route, { token: "expired", params: { email: "merchant@example.test" } })).statusCode, 401);
    assert.equal((await request(route, { token: "merchant", params: { email: "other@example.test" } })).statusCode, 403);
    assert.equal((await request(route, { token: "merchant", params: { email: "merchant@example.test" } })).statusCode, 200);
  } finally { closeCaches(h.deps); }
});

test("user directory is admin-only and merchant creation requires the authenticated account", async () => {
  const h = makeHarness();
  try {
    const directory = findRoute(h.app, "get", "/users");
    assert.equal((await request(directory)).statusCode, 401);
    assert.equal((await request(directory, { token: "merchant" })).statusCode, 403);
    assert.equal((await request(directory, { token: "admin" })).statusCode, 200);

    const createMerchant = findRoute(h.app, "post", "/merchants");
    assert.equal((await request(createMerchant, { body: { email: "merchant@example.test" } })).statusCode, 401);
    assert.equal((await request(createMerchant, {
      token: "other", body: { email: "merchant@example.test" },
    })).statusCode, 403);
  } finally { closeCaches(h.deps); }
});

test("hub manager list preserves admin full-list access and limits managers to their own record", async () => {
  const h = makeHarness();
  try {
    const route = findRoute(h.app, "get", "/users/hub-managers");
    assert.equal((await request(route)).statusCode, 401);
    assert.equal((await request(route, { token: "merchant" })).statusCode, 403);

    const adminList = await request(route, { token: "admin" });
    assert.equal(adminList.statusCode, 200);
    assert.deepEqual(adminList.body, [...h.hubManagers.values()]);

    const own = await request(route, { token: "managerA", query: { email: "manager-a@example.test" } });
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.body, h.hubManagers.get("manager-a@example.test"));

    const ownWithoutEmail = await request(route, { token: "managerA" });
    assert.equal(ownWithoutEmail.statusCode, 400);
    const crossProfile = await request(route, { token: "managerA", query: { email: "manager-b@example.test" } });
    assert.equal(crossProfile.statusCode, 403);
  } finally { closeCaches(h.deps); }
});

test("all hub parcel reads require the assigned hub from the manager record", async () => {
  const h = makeHarness();
  try {
    const routes = [
      ["get", "/parcels/incoming/:hubName"],
      ["get", "/parcels/pickups/:hubName"],
      ["get", "/warehouse/sorting-house/:hubName"],
      ["get", "/parcels/out-for-delivery/:hubName"],
      ["get", "/parcels/hub-delivered/:hubName"],
    ];
    for (const [method, path] of routes) {
      const route = findRoute(h.app, method, path);
      const assigned = await request(route, { token: "managerA", params: { hubName: "A" } });
      assert.equal(assigned.statusCode, 200, `${path} permits assigned hub`);
      const crossHub = await request(route, {
        token: "managerA",
        params: { hubName: "B" },
        query: { hubName: "A" },
      });
      assert.equal(crossHub.statusCode, 403, `${path} rejects URL hub substitution`);
    }

    const route = findRoute(h.app, "get", "/parcels/incoming/:hubName");
    assert.equal((await request(route, { params: { hubName: "A" } })).statusCode, 401);
    assert.equal((await request(route, { token: "merchant", params: { hubName: "A" } })).statusCode, 403);
  } finally { closeCaches(h.deps); }
});

test("hub manager merchant-area reads are limited to the assigned hub", async () => {
  const h = makeHarness();
  try {
    const route = findRoute(h.app, "get", "/area-merchant/:hubName");
    assert.equal((await request(route, { token: "managerA", params: { hubName: "A" } })).statusCode, 200);
    assert.equal((await request(route, { token: "managerA", params: { hubName: "B" } })).statusCode, 403);
    assert.equal((await request(route, { token: "admin", params: { hubName: "A" } })).statusCode, 403);
  } finally { closeCaches(h.deps); }
});

test("parcel mutations enforce the route-specific origin or destination hub atomically", async () => {
  const h = makeHarness();
  const originAId = "111111111111111111111111";
  const originBId = "222222222222222222222222";
  const destinationBId = "333333333333333333333333";
  for (const [id, origin, destination] of [
    [originAId, "A", "B"],
    [originBId, "B", "A"],
    [destinationBId, "A", "B"],
  ]) {
    h.parcels.set(id, {
      _id: new ObjectId(id),
      trackingID: `TRACK-${id.slice(0, 3)}`,
      parcelName: "Test parcel",
      codAmount: 10,
      senderInfo: { email: "merchant@example.test", name: "Sender" },
      receiverInfo: { name: "Receiver" },
      serviceCenters: { origin, destination },
    });
  }

  try {
    const dispatch = findRoute(h.app, "patch", "/parcels/dispatch/:id");
    const deniedDispatch = await request(dispatch, {
      token: "managerA", params: { id: originBId }, body: { hubName: "A" },
    });
    assert.equal(deniedDispatch.statusCode, 403);
    assert.equal(h.parcels.get(originBId).deliveryStatus, undefined);

    const allowedDispatch = await request(dispatch, {
      token: "managerA", params: { id: originAId }, body: { hubName: "B" },
    });
    assert.equal(allowedDispatch.statusCode, 200);
    assert.equal(h.parcels.get(originAId).deliveryStatus, "in-transit");

    const receiveAtDestination = findRoute(h.app, "patch", "/parcels/dest-hub/received/:id");
    assert.equal((await request(receiveAtDestination, {
      token: "managerA", params: { id: destinationBId }, body: { hubName: "A" },
    })).statusCode, 403);
    assert.equal((await request(receiveAtDestination, {
      token: "managerB", params: { id: destinationBId }, body: { hubName: "A" },
    })).statusCode, 200);

    const receiveAtOrigin = findRoute(h.app, "patch", "/parcels/origin-hub/received/:id");
    assert.equal((await request(receiveAtOrigin, {
      token: "managerB", params: { id: originAId }, body: { hubName: "B" },
    })).statusCode, 403);
    assert.equal((await request(receiveAtOrigin, {
      token: "managerA", params: { id: originAId }, body: { hubName: "B" },
    })).statusCode, 200);

    const invalidId = await request(dispatch, {
      token: "managerA", params: { id: "not-an-object-id" },
    });
    assert.equal(invalidId.statusCode, 400);
  } finally { closeCaches(h.deps); }
});

test("hub manager authorization fails closed when assignment data is missing", async () => {
  const h = makeHarness();
  try {
    const route = findRoute(h.app, "get", "/parcels/incoming/:hubName");
    h.hubManagers.delete("manager-a@example.test");
    assert.equal((await request(route, { token: "managerA", params: { hubName: "A" } })).statusCode, 403);
    h.hubManagers.set("manager-a@example.test", { email: "manager-a@example.test", hubName: "" });
    assert.equal((await request(route, { token: "managerA", params: { hubName: "A" } })).statusCode, 403);
  } finally { closeCaches(h.deps); }
});

test("profile update cannot mass-assign account role or onboarding state", async () => {
  const h = makeHarness();
  try {
    const response = await request(findRoute(h.app, "patch", "/users/update/:email"), {
      token: "merchant", params: { email: "merchant@example.test" },
      body: { email: "merchant@example.test", displayName: "Name", role: "admin", isOnboarded: true },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.updateCalls.at(-1).update, { $set: { displayName: "Name" } });
    assert.equal(h.users.get("merchant@example.test").role, "merchant");

    const merchantUpdate = await request(findRoute(h.app, "patch", "/merchant-update/:email"), {
      token: "merchant", params: { email: "merchant@example.test" },
      body: { email: "other@example.test", role: "admin", displayName: "Merchant" },
    });
    assert.equal(merchantUpdate.statusCode, 200);
    assert.deepEqual(h.merchantUpdateCalls.at(-1).update, { $set: { displayName: "Merchant" } });
  } finally { closeCaches(h.deps); }
});

test("parcel lookup and creation reject cross-merchant access and forged sender identity", async () => {
  const h = makeHarness();
  try {
    const detail = findRoute(h.app, "get", "/parcel/:parcelID");
    const crossMerchant = await request(detail, { token: "other", params: { parcelID: parcelId } });
    assert.equal(crossMerchant.statusCode, 403);

    const create = findRoute(h.app, "post", "/parcels");
    const forged = await request(create, {
      token: "merchant",
      body: { email: "merchant@example.test", senderInfo: { email: "other@example.test" } },
    });
    assert.equal(forged.statusCode, 403);

    const deleteRoute = findRoute(h.app, "delete", "/parcel/:id");
    const crossDelete = await request(deleteRoute, {
      token: "other", params: { id: parcelId }, body: { email: "other@example.test" },
    });
    assert.equal(crossDelete.statusCode, 403);
  } finally { closeCaches(h.deps); }
});

test("OTP attempts are capped and a successfully verified code cannot be replayed", async () => {
  const h = makeHarness();
  try {
    h.otpRecords.set("merchant@example.test", { otp: 123456, expiresAt: Date.now() + 60000, attemptCount: 0 });
    const route = findRoute(h.app, "post", "/verify-otp");
    for (let i = 0; i < 4; i += 1) {
      const invalid = await request(route, { body: { email: "merchant@example.test", otp: "000000" } });
      assert.equal(invalid.statusCode, 400);
    }
    const locked = await request(route, { body: { email: "merchant@example.test", otp: "000000" } });
    assert.equal(locked.statusCode, 429);
    assert.equal((await request(route, { body: { email: "merchant@example.test", otp: "123456" } })).statusCode, 429);

    h.otpRecords.set("other@example.test", { otp: 123456, expiresAt: Date.now() + 60000, attemptCount: 0 });
    const valid = await request(route, { body: { email: "other@example.test", otp: "123456" } });
    assert.equal(valid.statusCode, 200);
    const replay = await request(route, { body: { email: "other@example.test", otp: "123456" } });
    assert.equal(replay.statusCode, 400);

    h.otpRecords.set("expired@example.test", { otp: 123456, expiresAt: Date.now() - 1, attemptCount: 0 });
    const expired = await request(route, { body: { email: "expired@example.test", otp: "123456" } });
    assert.equal(expired.statusCode, 400);
    assert.equal(expired.body.error, "OTP has expired");
  } finally { closeCaches(h.deps); }
});

test("OTP sending uses a per-email cooldown and does not send duplicate messages", async () => {
  const h = makeHarness();
  try {
    const route = findRoute(h.app, "post", "/send-otp");
    const payload = { email: "merchant@example.test" };
    assert.equal((await request(route, { body: payload })).statusCode, 200);
    const second = await request(route, { body: payload });
    assert.equal(second.statusCode, 429);
    assert.equal(h.sentMessages.length, 1);
  } finally { closeCaches(h.deps); }
});

test("checkout amount comes from stored parcel data and payment verification rejects amount tampering", async () => {
  const h = makeHarness();
  try {
    const checkout = await request(findRoute(h.app, "post", "/payment-checkout"), {
      body: { parcelId, deliveryCharge: 1, senderEmail: "attacker@example.test" },
    });
    assert.equal(checkout.statusCode, 200);
    assert.equal(h.getCheckoutPayload().line_items[0].price_data.unit_amount, 4995);
    assert.equal(h.getCheckoutPayload().customer_email, "merchant@example.test");

    h.deps.stripe.checkout.sessions.retrieve = async () => ({
      payment_intent: "pi-bad", payment_status: "paid", mode: "payment", currency: "usd",
      metadata: { parcelId, trackingID: "TRACK-1" }, amount_total: 1,
      customer_email: "merchant@example.test",
    });
    const verify = await request(findRoute(h.app, "patch", "/verify-payment"), { query: { session_id: "cs-bad" } });
    assert.equal(verify.statusCode, 400);
    assert.equal(h.parcel.deliveryChargeStatus, "unpaid");
    assert.equal(h.paymentRows.size, 0);

    h.deps.stripe.checkout.sessions.retrieve = async () => ({
      payment_intent: "pi-once", payment_status: "paid", mode: "payment", currency: "usd",
      metadata: { parcelId, trackingID: "TRACK-1" }, amount_total: 4995,
      customer_email: "merchant@example.test",
    });
    const validFirst = await request(findRoute(h.app, "patch", "/verify-payment"), { query: { session_id: "cs-valid" } });
    assert.equal(validFirst.statusCode, 200);
    const replay = await request(findRoute(h.app, "patch", "/verify-payment"), { query: { session_id: "cs-valid" } });
    assert.equal(replay.body.message, "Already exist");
    assert.equal(h.paymentRows.size, 1);
  } finally { closeCaches(h.deps); }
});
