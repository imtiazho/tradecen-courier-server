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
    project() { return this; },
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
      flushAll: () => true,
    }]),
  );
  const middleware = (name) => (req, res, next) => {
    calls.push(name);
    next();
  };
  Object.assign(dependencies, {
    connectDB: async () => collections,
    withTransaction: async (callback) => callback({}),
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

test("rider deletion updates the correctly named user collection in one transaction", async () => {
  let transactionCount = 0;
  const { app, collections } = makeHarness({
    withTransaction: async (callback) => {
      transactionCount += 1;
      return callback({});
    },
  });
  const rider = { email: "rider@example.test", area: "North" };
  let updatedUser;
  collections.ridersCollections.findOne = async () => rider;
  collections.ridersCollections.deleteOne = async () => ({ deletedCount: 1 });
  collections.userCollections.updateOne = async (filter, update, options) => {
    updatedUser = { filter, update, options };
    return { matchedCount: 1, modifiedCount: 1 };
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await invoke(locateRoute(app, "delete", "/riders/:id"), {
      query: {}, params: { id: "rider-1" }, body: {},
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.message, "Rider request deleted and user role reset to user");
  assert.equal(response.body.deleteResult.deletedCount, 1);
  assert.deepEqual(updatedUser.filter, { email: rider.email });
  assert.deepEqual(updatedUser.update, { $set: { role: "user" } });
  assert.ok(updatedUser.options.session);
  assert.equal(transactionCount, 1);
});

test("rider deletion returns 404 for a missing rider without updating users", async () => {
  const { app, collections } = makeHarness();
  let updateCount = 0;
  collections.ridersCollections.findOne = async () => null;
  collections.userCollections.updateOne = async () => { updateCount += 1; };

  const response = await invoke(locateRoute(app, "delete", "/riders/:id"), {
    query: {}, params: { id: "missing-rider" }, body: {},
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { success: false, message: "Rider request not found" });
  assert.equal(updateCount, 0);
});

test("rider deletion rolls back if the associated user update fails", async () => {
  let riderDeleted = false;
  const { app, collections } = makeHarness({
    withTransaction: async (callback) => {
      const priorState = riderDeleted;
      try {
        return await callback({});
      } catch (error) {
        riderDeleted = priorState;
        throw error;
      }
    },
  });
  collections.ridersCollections.findOne = async () => ({ email: "rider@example.test" });
  collections.ridersCollections.deleteOne = async () => {
    riderDeleted = true;
    return { deletedCount: 1 };
  };
  collections.userCollections.updateOne = async () => { throw new Error("mock user update failure"); };

  const originalConsoleError = console.error;
  console.error = () => {};
  let response;
  try {
    response = await invoke(locateRoute(app, "delete", "/riders/:id"), {
      query: {}, params: { id: "rider-1" }, body: {},
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { success: false, message: "Internal Server Error" });
  assert.equal(riderDeleted, false);
});

test("parcel booking and rider pickup, assignment, delivery, and return handlers execute", async () => {
  const parcel = {
    _id: "parcel-1",
    trackingID: "T-3",
    parcelName: "Package",
    codAmount: 500,
    senderInfo: { email: "merchant@example.test", name: "Merchant", address: "A", phone: "1" },
    receiverInfo: { name: "Receiver", address: "B", phone: "2", area: "North" },
    serviceCenters: { origin: "South", destination: "North" },
  };
  const { app, calls, collections } = makeHarness();
  collections.parcelsCollections.findOne = async () => parcel;
  collections.ridersCollections.findOne = async () => ({ email: "rider@example.test", area: "North" });

  const booking = await invoke(locateRoute(app, "post", "/parcels"), {
    query: {}, params: {}, body: parcel,
  });
  assert.deepEqual(booking.body, { insertedId: "inserted-id" });
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "tracking"));

  const assignment = await invoke(locateRoute(app, "patch", "/parcels/assign-rider"), {
    query: {}, params: {}, body: {
      parcelId: "parcel-1", riderId: "rider-1", riderName: "Rider",
      riderEmail: "rider@example.test", riderPhone: "3", trackingID: "T-3",
    },
  });
  assert.equal(assignment.statusCode, 200);
  assert.deepEqual(assignment.body, { success: true, message: "Rider assigned successfully" });

  const pickup = await invoke(locateRoute(app, "patch", "/riders/complete-pickup/update"), {
    query: {}, params: {}, body: { riderId: "rider-1", parcelId: "parcel-1", trackingID: "T-3" },
  });
  assert.deepEqual(pickup.body.success, true);

  const delivered = await invoke(locateRoute(app, "patch", "/riders/complete-delivered/update"), {
    query: {}, params: {}, body: { riderId: "rider-1", parcelId: "parcel-1", trackingID: "T-3" },
  });
  assert.deepEqual(delivered.body.success, true);

  const returnRequest = await invoke(locateRoute(app, "patch", "/riders/return-req/update"), {
    query: {}, params: {}, body: { riderId: "rider-1", parcelId: "parcel-1" },
  });
  assert.deepEqual(returnRequest.body, {
    success: true,
    message: "Return request processed. Parcel moved from Active Tasks to Return Ledger.",
  });
});

test("dispatch, hub receiving, and return reception keep parcel lifecycle responses", async () => {
  const parcel = {
    trackingID: "T-4",
    senderInfo: { email: "merchant@example.test" },
    serviceCenters: { origin: "South", destination: "North" },
    deliveryRider: { email: "rider@example.test" },
  };
  const { app, collections } = makeHarness();
  collections.parcelsCollections.findOne = async () => parcel;

  for (const [path, params] of [
    ["/parcels/dispatch/:id", { id: "parcel-1" }],
    ["/parcels/dest-hub/received/:id", { id: "parcel-1" }],
    ["/parcels/origin-hub/received/:id", { id: "parcel-1" }],
  ]) {
    const response = await invoke(locateRoute(app, "patch", path), {
      query: {}, params, body: {},
    });
    assert.deepEqual(response.body, {
      success: true,
      message: "Parcel status updated to in-transit",
    });
  }

  const receivedReturn = await invoke(
    locateRoute(app, "patch", "/parcels/return-hub/received/:parcelId"),
    { query: {}, params: { parcelId: "parcel-1" }, body: { managerEmail: "manager@example.test" } },
  );
  assert.deepEqual(receivedReturn.body, {
    success: true,
    message: "Return successfully received at hub and cleared from rider task.",
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

  collections.parcelsCollections.find = () => cursor([{
    _id: "parcel-2", codAmount: 300, deliveryCharge: 50,
    deliveryChargeStatus: "paid", senderInfo: { name: "Merchant" },
  }]);
  const payoutRequest = await invoke(locateRoute(app, "post", "/request-payout"), {
    query: {}, params: {}, body: { email: "merchant@example.test", withdrawAmount: 250 },
  });
  assert.deepEqual(payoutRequest.body, {
    success: true,
    message: "Payout request submitted successfully. Waiting for admin approval.",
    insertedId: "inserted-id",
  });

  collections.payoutsCollections.findOne = async () => ({
    email: "merchant@example.test",
    parcelsBreakdown: [{ parcelId: "parcel-2" }],
  });
  const payoutApproval = await invoke(locateRoute(app, "patch", "/approve-payout/:id"), {
    query: {}, params: { id: "payout-1" }, body: { status: "Completed", trxID: "TRX-1" },
  });
  assert.deepEqual(payoutApproval.body, {
    success: true,
    message: "Payout approved and completed successfully!",
  });
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

  const deposit = await invoke(locateRoute(app, "post", "/deposit-HQ/:hubName"), {
    query: {}, params: { hubName: "North" },
    body: { depositedAmount: 100, parcelIds: ["parcel-6"], submittedBy: "Manager" },
  });
  assert.equal(deposit.statusCode, 201);
  assert.deepEqual(deposit.body, {
    success: true,
    message: "Deposit request submitted to HQ successfully!",
    depositId: "inserted-id",
  });

  collections.hqPaymentsCollections.findOne = async () => ({ hubName: "North", parcelIds: ["parcel-6"] });
  const depositApproval = await invoke(locateRoute(app, "patch", "/approve-deposit/:id"), {
    query: {}, params: { id: "invoice-1" }, body: {},
  });
  assert.deepEqual(depositApproval.body, { success: true, message: "Deposit approved successfully!" });

  const dashboard = await invoke(locateRoute(app, "get", "/master-admin/main-dashboard"), {
    query: {}, params: {}, body: {},
  });
  assert.equal(JSON.parse(dashboard.body).success, true);
  assert.equal(JSON.parse(dashboard.body).metrics.totalParcels, 0);

  const checkout = await invoke(locateRoute(app, "post", "/payment-checkout"), {
    query: {}, params: {}, body: { deliveryCharge: "50", parcelName: "Box", parcelId: "p1", senderEmail: "a@example.test" },
  });
  assert.equal(checkout.body.url, "https://stripe.invalid/session");

  const paymentHarness = makeHarness({
    stripe: {
      checkout: {
        sessions: {
          create: async () => ({ url: "https://stripe.invalid/session" }),
          retrieve: async () => ({
            payment_intent: "transaction-1",
            payment_status: "paid",
            metadata: { parcelId: "parcel-5", trackingID: "T-5", percelName: "Box" },
            amount_total: 5000,
            customer_email: "merchant@example.test",
          }),
        },
      },
    },
  });
  paymentHarness.collections.parcelsCollections.findOneAndUpdate = async () => ({
    senderInfo: { email: "merchant@example.test" },
    serviceCenters: { origin: "South", destination: "North" },
  });
  const verifiedPayment = await invoke(
    locateRoute(paymentHarness.app, "patch", "/verify-payment"),
    { query: { session_id: "session-1" }, params: {}, body: {} },
  );
  assert.deepEqual(verifiedPayment.body, {
    success: true,
    product: "Box",
    amount: 50,
    customer_email: "merchant@example.test",
    transactionId: "transaction-1",
    trackingID: "T-5",
    paidAt: verifiedPayment.body.paidAt,
  });

  const otp = await invoke(locateRoute(app, "post", "/verify-otp"), {
    query: {}, params: {}, body: { email: "user@example.test", otp: "123456" },
  });
  assert.deepEqual(otp.body, { success: true, message: "OTP verified" });

  const sendOtp = await invoke(locateRoute(app, "post", "/send-otp"), {
    query: {}, params: {}, body: { email: "user@example.test" },
  });
  assert.deepEqual(sendOtp.body, { success: true, message: "OTP sent successfully" });

  const resetPassword = await invoke(locateRoute(app, "post", "/reset-password"), {
    query: {}, params: {}, body: { email: "user@example.test", newPassword: "test-password" },
  });
  assert.deepEqual(resetPassword.body, { success: true, message: "Password updated successfully" });
});

test("tracking query preserves its database-failure response", async () => {
  const { app } = makeHarness({
    connectDB: async () => { throw new Error("mock database failure"); },
  });
  const response = await invoke(locateRoute(app, "get", "/tracking/:id"), {
    query: {}, params: { id: "T-failure" }, body: {},
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, { message: "Error loading tracking logs" });
});
