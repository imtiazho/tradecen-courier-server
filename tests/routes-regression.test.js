const assert = require("node:assert/strict");
const express = require("express");
const { test } = require("node:test");

const registerRoutes = require("../src/routes");

const cacheNames = [
  "trackingCache", "usersCache", "userCache", "userRoleCache", "managerCache",
  "incomingParcelsCache", "merchantParcelsCache", "pickupCache", "sortingCache",
  "outForDeliveryCache", "hubDeliveredCache", "riderCache", "ridersCache",
  "availableRidersCache", "returnWarehouseCache", "allMerchantsCache",
  "merchantsAreaWiseCache", "targetedMerchantCache", "payoutSummaryCache",
  "allPayoutsCache", "parcelDetailCache", "lateInvoicesCache", "merchantUnpaidCache",
  "parcelsStatusWiseCache", "parcelStatsCache", "revenueStatsCache", "hubHandCashCache",
  "hubProfitCache", "hubAgingCache", "hubEfficiencyCache", "depositHistoryCache",
  "mainDashboardCache",
];

function cursor(items = []) {
  return {
    sort() { return this; },
    limit() { return this; },
    skip() { return this; },
    toArray: async () => items,
  };
}

function collection(overrides = {}) {
  return {
    find: () => cursor(),
    findOne: async () => null,
    findOneAndUpdate: async () => null,
    updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    updateMany: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    insertOne: async () => ({ insertedId: "inserted-id" }),
    deleteOne: async () => ({ deletedCount: 1 }),
    countDocuments: async () => 0,
    estimatedDocumentCount: async () => 0,
    aggregate: () => cursor(),
    ...overrides,
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const collections = {
    userCollections: collection(),
    hubManagersCollection: collection(),
    ridersCollections: collection(),
    merchantsCollections: collection(),
    parcelsCollections: collection(),
    paymentCollections: collection(),
    trackingLogsCollections: collection(),
    payoutsCollections: collection(),
    hqPaymentsCollections: collection(),
  };
  const dependencies = Object.fromEntries(
    cacheNames.map((name) => [name, {
      get: () => undefined,
      set: () => true,
      del: () => true,
      bump: () => true,
    }]),
  );
  const middleware = (name) => (req, res, next) => {
    calls.push(name);
    next();
  };
  Object.assign(dependencies, {
    connectDB: async () => collections,
    verifyFireBaseToken: middleware("firebase"),
    verifyAdminToken: middleware("admin"),
    verifyMerchantToken: middleware("merchant"),
    verifyRiderToken: middleware("rider"),
    verifyHubManagerToken: middleware("hub-manager"),
    verifyOwner: middleware("owner"),
    verifyRoles: (...roles) => {
      return (req, res, next) => {
        calls.push(`roles:${roles.join(",")}`);
        next();
      };
    },
    logTracking: async (...args) => calls.push(["tracking", ...args]),
    invalidateParcelStatusChange: () => calls.push("invalidate-cache"),
    ObjectId: class ObjectId {
      constructor(value) { this.value = value; }
    },
    stripe: {
      checkout: {
        sessions: {
          create: async (payload) => ({ url: "https://stripe.invalid/session", payload }),
          retrieve: async () => ({}),
        },
      },
    },
    transporter: { sendMail: async () => {} },
    pendingRequests: new Map(),
    pendingHubRequests: new Map(),
    pendingHubProfitRequests: new Map(),
    pendingHubAgingRequests: new Map(),
    pendingHubEfficiencyRequests: new Map(),
    pendingDepositHistoryRequests: new Map(),
    pendingDashboardRequests: new Map(),
    admin: {
      auth: () => ({
        getUserByEmail: async () => ({ uid: "uid-1" }),
        updateUser: async () => ({}),
      }),
      firestore: () => ({
        collection: () => ({
          doc: () => ({
            get: async () => ({ exists: true, data: () => ({ otp: 123456, expiresAt: Date.now() + 60000 }) }),
            set: async () => ({}),
            delete: async () => ({}),
          }),
        }),
      }),
    },
    ...overrides,
  });
  const app = express();
  registerRoutes(app, dependencies);
  return { app, calls, collections, dependencies };
}

function locateRoute(app, method, routePath) {
  function walk(stack) {
    for (const layer of stack) {
      if (layer.route && layer.route.path === routePath && layer.route.methods[method.toLowerCase()]) {
        return layer.route;
      }
      if (layer.handle?.stack) {
        const found = walk(layer.handle.stack);
        if (found) return found;
      }
    }
    return null;
  }
  const route = walk(app.router.stack);
  assert.ok(route, `${method} ${routePath} is registered`);
  return route;
}

async function invoke(route, request) {
  const response = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; },
  };
  for (const layer of route.stack) {
    const handler = layer.handle;
    if (handler.length >= 3) {
      await new Promise((resolve, reject) => handler(request, response, (error) => error ? reject(error) : resolve()));
    } else {
      await handler(request, response);
    }
    if (Object.hasOwn(response, "body")) break;
  }
  return response;
}

test("hub manager listing and promotion resolve their MongoDB collections and preserve middleware order", async () => {
  const manager = { email: "manager@example.test", hubName: "North" };
  const { app, calls, collections } = makeHarness();
  collections.hubManagersCollection.find = () => cursor([manager]);
  collections.userCollections.updateOne = async () => ({ modifiedCount: 1 });
  collections.userCollections.findOne = async () => ({ _id: "user-id", displayName: "Manager" });

  const listing = await invoke(locateRoute(app, "get", "/users/hub-managers"), {
    query: {}, params: {}, body: {},
  });
  assert.equal(listing.statusCode, 200);
  assert.deepEqual(listing.body, [manager]);

  const promotion = await invoke(locateRoute(app, "patch", "/users/make-hub-manager"), {
    query: {}, params: {}, body: { email: manager.email, region: "R", district: "D", hubName: manager.hubName },
  });
  assert.deepEqual(calls.slice(0, 2), ["firebase", "admin"]);
  assert.deepEqual(promotion.body, {
    success: true,
    message: "User promoted and added to Hub Managers collection",
  });
});

test("rider status update reaches the injected rider collection", async () => {
  const { app, collections } = makeHarness();
  collections.ridersCollections.findOne = async () => ({ area: "Uttara" });
  const response = await invoke(locateRoute(app, "patch", "/rider/status/:email"), {
    query: {}, params: { email: "rider@example.test" }, body: { workStatus: "available" },
  });
  assert.deepEqual(response.body, {
    success: true,
    message: "Rider status synchronized successfully!",
  });
});

test("hub parcel lifecycle keeps its auth middleware order and tracking side effect", async () => {
  const parcel = {
    trackingID: "T-1",
    senderInfo: { email: "merchant@example.test" },
    serviceCenters: { origin: "Dhaka", destination: "Chattogram" },
  };
  const { app, calls, collections } = makeHarness();
  collections.parcelsCollections.findOne = async () => parcel;
  const response = await invoke(locateRoute(app, "patch", "/parcels/origin-hub/received/:id"), {
    query: {}, params: { id: "0123456789abcdef01234567" }, body: {},
  });
  assert.deepEqual(calls.slice(0, 2), ["firebase", "hub-manager"]);
  assert.deepEqual(response.body, { success: true, message: "Parcel status updated to in-transit" });
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "tracking"));
});

test("merchant creation and payout listing use their injected collections", async () => {
  const { app, collections } = makeHarness();
  const merchantResponse = await invoke(locateRoute(app, "post", "/merchants"), {
    query: {}, params: {}, body: { email: "merchant@example.test", area: "Uttara" },
  });
  assert.deepEqual(merchantResponse.body, { insertedId: "inserted-id" });

  collections.payoutsCollections.find = () => cursor([{ payoutStatus: "pending" }]);
  const payoutResponse = await invoke(locateRoute(app, "get", "/all-payouts"), {
    query: {}, params: {}, body: {},
  });
  assert.deepEqual(payoutResponse.body, { success: true, data: [{ payoutStatus: "pending" }] });
});

test("tracking query, hub finance, checkout, and OTP verification execute with mocked services", async () => {
  const { app, collections } = makeHarness();
  collections.trackingLogsCollections.find = () => cursor([{ trackingID: "T-2" }]);
  const tracking = await invoke(locateRoute(app, "get", "/tracking/:id"), {
    query: {}, params: { id: "T-2" }, body: {},
  });
  assert.deepEqual(tracking.body, { success: true, result: [{ trackingID: "T-2" }] });

  const finance = await invoke(locateRoute(app, "get", "/hub-hand-cash/:hubName"), {
    query: {}, params: { hubName: "North" }, body: {},
  });
  assert.equal(finance.statusCode, 200);
  assert.equal(JSON.parse(finance.body).totalHandCash, 0);

  const checkout = await invoke(locateRoute(app, "post", "/payment-checkout"), {
    query: {}, params: {}, body: { deliveryCharge: "50", parcelName: "Box", parcelId: "p1", senderEmail: "a@example.test" },
  });
  assert.equal(checkout.body.url, "https://stripe.invalid/session");

  const otp = await invoke(locateRoute(app, "post", "/verify-otp"), {
    query: {}, params: {}, body: { email: "user@example.test", otp: "123456" },
  });
  assert.deepEqual(otp.body, { success: true, message: "OTP verified" });
});
