const assert = require("node:assert/strict");
const { test } = require("node:test");

const createRouteDependencies = require("../src/routes/dependencies");
const createRidersRouter = require("../src/routes/riders");

const RIDER_ID = "rider-1";
const PARCEL_ID = "parcel-1";
const RIDER_EMAIL = "rider@example.test";

function clone(value) {
  return structuredClone(value);
}

function cursor(items) {
  return {
    sort() { return this; },
    toArray: async () => items,
  };
}

function valueOfId(value) {
  return value && typeof value === "object" && "value" in value
    ? value.value
    : value;
}

function matches(record, query = {}) {
  return Object.entries(query).every(([field, expected]) => {
    if (field === "$or") return expected.some((part) => matches(record, part));
    if (field.startsWith("$")) return true;
    const actual = field.split(".").reduce((value, key) => value?.[key], record);
    if (expected && typeof expected === "object" && "$lt" in expected) {
      return actual < expected.$lt;
    }
    return String(valueOfId(actual)) === String(valueOfId(expected));
  });
}

function makeHarness({ failParcelUpdate = false, failTracking = false } = {}) {
  const riders = [
    {
      _id: RIDER_ID,
      email: RIDER_EMAIL,
      area: "North",
      status: "approved",
      workStatus: "available",
      currentTasks: 1,
      totalAssign: 1,
      successfullyComplete: 0,
      activeTasks: [{ parcelId: PARCEL_ID, isHold: false, taskType: "delivery" }],
      returnLedger: [],
    },
    {
      _id: "rider-2",
      email: "second@example.test",
      area: "South",
      status: "a",
      workStatus: "b|c",
      currentTasks: 0,
      activeTasks: [],
    },
  ];
  const parcel = {
    _id: PARCEL_ID,
    trackingID: "TRACK-1",
    parcelName: "Mock parcel",
    deliveryStatus: "assign-delivery-rider",
    codAmount: 100,
    senderInfo: { email: "merchant@example.test", name: "Merchant" },
    receiverInfo: { name: "Receiver", area: "North", address: "Test address" },
    serviceCenters: { origin: "North", destination: "South" },
    deliveryRider: { id: RIDER_ID, email: RIDER_EMAIL },
    pickupRider: { id: RIDER_ID, email: RIDER_EMAIL },
  };
  let parcelUpdateCalls = 0;

  const ridersCollections = {
    findOne: async (query) => {
      const found = riders.find((rider) => matches(rider, query));
      return found ? clone(found) : null;
    },
    find: (query = {}) => cursor(riders.filter((rider) => matches(rider, query)).map(clone)),
    updateOne: async (query, update, options = {}) => {
      const rider = riders.find((candidate) => matches(candidate, query));
      if (!rider) return { matchedCount: 0, modifiedCount: 0 };

      for (const [field, value] of Object.entries(update.$set || {})) {
        if (field === "activeTasks.$[elem].isHold") {
          const parcelFilter = options.arrayFilters?.[0]?.["elem.parcelId"];
          for (const task of rider.activeTasks || []) {
            if (String(valueOfId(task.parcelId)) === String(valueOfId(parcelFilter))) {
              task.isHold = value;
            }
          }
        } else {
          rider[field] = value;
        }
      }
      for (const [field, value] of Object.entries(update.$inc || {})) {
        rider[field] = (rider[field] || 0) + value;
      }
      for (const [field, value] of Object.entries(update.$pull || {})) {
        const removeId = value.parcelId || value._id;
        rider[field] = (rider[field] || []).filter(
          (item) => String(valueOfId(item.parcelId || item._id)) !== String(valueOfId(removeId)),
        );
      }
      for (const [field, value] of Object.entries(update.$push || {})) {
        rider[field] = rider[field] || [];
        rider[field].push(clone(value));
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };

  const parcelsCollections = {
    find: () => cursor([clone(parcel)]),
    findOne: async () => clone(parcel),
    updateOne: async (_query, update) => {
      parcelUpdateCalls += 1;
      if (failParcelUpdate) throw new Error("mock parcel write failure");
      Object.assign(parcel, clone(update.$set || {}));
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOneAndUpdate: async (_query, update) => {
      Object.assign(parcel, clone(update.$set || {}));
      return clone(parcel);
    },
  };

  const collections = {
    ridersCollections,
    parcelsCollections,
    merchantsCollections: { updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }) },
    hubManagersCollection: { updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }) },
  };

  process.env.STRIPE_SECRET = "sk_test_rider_cache_placeholder";
  const dependencies = createRouteDependencies({
    admin: {},
    connectDB: async () => collections,
    withTransaction: async (callback) => callback({}),
  });
  delete process.env.STRIPE_SECRET;
  dependencies.ObjectId = class ObjectId {
    constructor(value) { this.value = value; }
  };
  dependencies.verifyFireBaseToken = (_req, _res, next) => next();
  dependencies.verifyRiderToken = (_req, _res, next) => next();
  dependencies.verifyHubManagerToken = (_req, _res, next) => next();
  dependencies.verifyAdminToken = (_req, _res, next) => next();
  dependencies.logTracking = async () => {
    if (failTracking) throw new Error("mock tracking failure");
  };
  dependencies.invalidateParcelStatusChange = () => {};

  const router = createRidersRouter(dependencies);
  return {
    router,
    dependencies,
    riders,
    parcel,
    get parcelUpdateCalls() { return parcelUpdateCalls; },
  };
}

function closeCaches(dependencies) {
  for (const value of Object.values(dependencies)) {
    if (typeof value?.close === "function") value.close();
    if (typeof value?.store?.close === "function") value.store.close();
  }
}

function findRoute(router, method, routePath) {
  const layer = router.stack.find(
    (candidate) => candidate.route?.path === routePath && candidate.route.methods[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${routePath} is registered`);
  return layer.route;
}

async function invoke(route, { params = {}, query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
  };
  const req = { params, query, body, headers: {} };
  for (const layer of route.stack) {
    let nextCalled = false;
    await new Promise((resolve, reject) => {
      const next = (error) => {
        if (error) return reject(error);
        nextCalled = true;
        resolve();
      };
      try {
        const result = layer.handle(req, res, next);
        if (result && typeof result.then === "function") {
          result.then(() => {
            if (!nextCalled && Object.hasOwn(res, "body")) resolve();
          }, reject);
        } else if (!nextCalled && Object.hasOwn(res, "body")) {
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    });
    if (Object.hasOwn(res, "body")) break;
  }
  return res;
}

async function cachedList(router, query = { email: RIDER_EMAIL }) {
  return invoke(findRoute(router, "get", "/riders"), { query });
}

async function cachedProfile(router) {
  return invoke(findRoute(router, "get", "/rider/:email"), {
    params: { email: RIDER_EMAIL },
  });
}

async function cachedAvailableRiders(router) {
  return invoke(findRoute(router, "get", "/riders/available/:areaName"), {
    params: { areaName: "North" },
  });
}

const updateCases = [
  {
    name: "hold parcel",
    path: "/riders/hold-parcel/update",
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID },
    assertState: ({ rider, parcel }) => {
      assert.equal(rider.activeTasks[0].isHold, true);
      assert.equal(parcel.deliveryStatus, "hold");
    },
  },
  {
    name: "complete pickup",
    path: "/riders/complete-pickup/update",
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID, trackingID: "TRACK-1" },
    assertState: ({ rider, parcel }) => {
      assert.equal(rider.activeTasks.length, 0);
      assert.equal(rider.currentTasks, 0);
      assert.equal(parcel.deliveryStatus, "picked-up");
    },
  },
  {
    name: "complete delivery",
    path: "/riders/complete-delivered/update",
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID, trackingID: "TRACK-1" },
    assertState: ({ rider, parcel }) => {
      assert.equal(rider.activeTasks.length, 0);
      assert.equal(rider.currentTasks, 0);
      assert.equal(parcel.deliveryStatus, "delivered");
    },
  },
  {
    name: "request return",
    path: "/riders/return-req/update",
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID },
    assertState: ({ rider, parcel }) => {
      assert.equal(rider.activeTasks.length, 0);
      assert.equal(rider.returnLedger.length, 1);
      assert.equal(rider.currentTasks, 0);
      assert.equal(parcel.deliveryStatus, "return-requested");
    },
  },
  {
    name: "complete return delivery",
    path: "/riders/complete-return-delivered/update",
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID, trackingID: "TRACK-1" },
    assertState: ({ rider, parcel }) => {
      assert.equal(rider.activeTasks.length, 0);
      assert.equal(rider.currentTasks, 0);
      assert.equal(parcel.deliveryStatus, "returned-to-merchant");
    },
  },
];

for (const scenario of updateCases) {
  test(`real NodeCache entries refresh after ${scenario.name}`, async (t) => {
    const harness = makeHarness();
    t.after(() => closeCaches(harness.dependencies));

    const beforeList = await cachedList(harness.router);
    const beforeAreaList = await cachedList(harness.router, { area: "North" });
    const beforeProfile = await cachedProfile(harness.router);
    const beforeAvailable = await cachedAvailableRiders(harness.router);
    assert.equal(beforeList.body[0].currentTasks, 1);
    assert.equal(beforeAreaList.body[0].currentTasks, 1);
    assert.equal(beforeProfile.body.riderData.currentTasks, 1);
    assert.equal(beforeAvailable.body[0].currentTasks, 1);
    harness.dependencies.mainDashboardCache.set("master_admin_main_dashboard", "cached-dashboard");

    const response = await invoke(findRoute(harness.router, "patch", scenario.path), {
      body: scenario.body,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    scenario.assertState({ rider: harness.riders[0], parcel: harness.parcel });

    const afterList = await cachedList(harness.router);
    const afterAreaList = await cachedList(harness.router, { area: "North" });
    const afterProfile = await cachedProfile(harness.router);
    assert.deepEqual(afterList.body[0], harness.riders[0]);
    assert.deepEqual(afterAreaList.body[0], harness.riders[0]);
    assert.deepEqual(afterProfile.body.riderData, harness.riders[0]);
    assert.deepEqual(
      harness.dependencies.riderCache.get(`rider_${encodeURIComponent(RIDER_EMAIL)}`).riderData,
      harness.riders[0],
    );

    if (scenario.name !== "hold parcel") {
      const afterAvailable = await cachedAvailableRiders(harness.router);
      assert.equal(afterAvailable.body[0].currentTasks, 0);
      assert.equal(harness.dependencies.mainDashboardCache.get("master_admin_main_dashboard"), undefined);
    }
  });
}

test("rider list query filters with delimiter characters use distinct cache entries", async (t) => {
  const harness = makeHarness();
  t.after(() => closeCaches(harness.dependencies));
  harness.riders[0].status = "a|b";
  harness.riders[0].workStatus = "c";

  const first = await cachedList(harness.router, { status: "a|b", workStatus: "c" });
  const second = await cachedList(harness.router, { status: "a", workStatus: "b|c" });
  assert.equal(first.body[0]._id, RIDER_ID);
  assert.equal(second.body[0]._id, "rider-2");
});

test("failed rider update does not cache optimistic state or invalidate an untouched record", async (t) => {
  const harness = makeHarness({ failParcelUpdate: true });
  t.after(() => closeCaches(harness.dependencies));
  const before = await cachedList(harness.router);

  const response = await invoke(findRoute(harness.router, "patch", "/riders/complete-pickup/update"), {
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID, trackingID: "TRACK-1" },
  });

  assert.equal(response.statusCode, 500);
  assert.equal(harness.parcelUpdateCalls, 1);
  assert.equal(harness.parcel.deliveryStatus, "assign-delivery-rider");
  const after = await cachedList(harness.router);
  assert.deepEqual(after.body, before.body);
  assert.equal(harness.riders[0].currentTasks, 1);
});

test("partial parcel success invalidates the Rider profile before a later tracking failure", async (t) => {
  const harness = makeHarness({ failTracking: true });
  t.after(() => closeCaches(harness.dependencies));
  await cachedProfile(harness.router);

  const response = await invoke(findRoute(harness.router, "patch", "/riders/complete-delivered/update"), {
    body: { riderId: RIDER_ID, parcelId: PARCEL_ID, trackingID: "TRACK-1" },
  });

  assert.equal(response.statusCode, 500);
  assert.equal(harness.parcel.deliveryStatus, "delivered");
  assert.equal(
    harness.dependencies.riderCache.get(`rider_${encodeURIComponent(RIDER_EMAIL)}`),
    undefined,
  );
});

