const assert = require("node:assert/strict");
const express = require("express");
const { ObjectId } = require("mongodb");
const { test } = require("node:test");
const createRouteDependencies = require("../src/routes/dependencies");
const createRidersRouter = require("../src/routes/riders");

const RIDER_A_ID = "111111111111111111111111";
const RIDER_B_ID = "222222222222222222222222";
const PARCEL_A_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PARCEL_B_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";

function valueMatches(actual, expected) {
  if (expected && typeof expected === "object" && !(expected instanceof ObjectId)) {
    if ("$lt" in expected) return actual < expected.$lt;
    if ("$in" in expected) return expected.$in.includes(actual);
  }
  return String(actual) === String(expected);
}

function matches(record, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return expected.some((part) => matches(record, part));
    const actual = key.split(".").reduce((value, part) => value?.[part], record);
    return valueMatches(actual, expected);
  });
}

function cursor(records) {
  let items = records;
  return {
    sort() { return this; },
    project(projection) {
      items = items.map((item) => Object.fromEntries(
        Object.entries(projection).filter(([, include]) => include).map(([key]) => [key, item[key]]),
      ));
      return this;
    },
    toArray: async () => items,
  };
}

function makeHarness() {
  process.env.STRIPE_SECRET = "sk_test_riders_phase_a_placeholder";
  const users = new Map([
    ["rider-a@example.test", { email: "rider-a@example.test", role: "rider" }],
    ["rider-b@example.test", { email: "rider-b@example.test", role: "rider" }],
    ["applicant@example.test", { email: "applicant@example.test", role: "user" }],
    ["admin@example.test", { email: "admin@example.test", role: "admin" }],
    ["manager-a@example.test", { email: "manager-a@example.test", role: "hub-manager" }],
    ["manager-b@example.test", { email: "manager-b@example.test", role: "hub-manager" }],
    ["merchant@example.test", { email: "merchant@example.test", role: "merchant" }],
  ]);
  const riders = new Map([
    [RIDER_A_ID, { _id: new ObjectId(RIDER_A_ID), email: "rider-a@example.test", name: "Rider A", phone: "111", area: "A", status: "active", workStatus: "available", currentTasks: 0, totalAssign: 0, successfullyComplete: 0, activeTasks: [] }],
    [RIDER_B_ID, { _id: new ObjectId(RIDER_B_ID), email: "rider-b@example.test", name: "Rider B", phone: "222", area: "B", status: "active", workStatus: "available", currentTasks: 0, totalAssign: 0, successfullyComplete: 0, activeTasks: [] }],
  ]);
  const managers = new Map([
    ["manager-a@example.test", { email: "manager-a@example.test", hubName: "A" }],
    ["manager-b@example.test", { email: "manager-b@example.test", hubName: "B" }],
  ]);
  const parcels = new Map([
    [PARCEL_A_ID, { _id: new ObjectId(PARCEL_A_ID), trackingID: "TA", parcelName: "Parcel A", codAmount: 10, senderInfo: { email: "sender@example.test", name: "Sender", phone: "333", address: "Origin A", area: "A" }, receiverInfo: { name: "Receiver", phone: "444", address: "Destination B", area: "B" }, serviceCenters: { origin: "A", destination: "B" }, deliveryStatus: "parcel-created" }],
    [PARCEL_B_ID, { _id: new ObjectId(PARCEL_B_ID), trackingID: "TB", parcelName: "Parcel B", codAmount: 20, senderInfo: { email: "sender@example.test", name: "Sender", phone: "333", address: "Origin B", area: "B" }, receiverInfo: { name: "Receiver", phone: "444", address: "Destination A", area: "A" }, serviceCenters: { origin: "B", destination: "A" }, deliveryStatus: "reached-destination-warehouse" }],
  ]);
  const writes = [];
  const findOne = async (map, filter) => [...map.values()].find((item) => matches(item, filter)) || null;
  const updateOne = async (map, filter, update) => {
    writes.push({ collection: map, filter, update });
    const item = await findOne(map, filter);
    if (!item) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(item, update.$set || {});
    for (const [key, increment] of Object.entries(update.$inc || {})) item[key] = (item[key] || 0) + increment;
    for (const [key, value] of Object.entries(update.$push || {})) (item[key] ||= []).push(value);
    return { matchedCount: 1, modifiedCount: 1 };
  };
  const ridersCollections = {
    findOne: (filter) => findOne(riders, filter),
    find: (filter = {}) => cursor([...riders.values()].filter((item) => matches(item, filter))),
    updateOne: (filter, update) => updateOne(riders, filter, update),
    insertOne: async (item) => { const id = new ObjectId(); const row = { _id: id, ...item }; riders.set(String(id), row); return { insertedId: id }; },
    deleteOne: async (filter) => { const item = await findOne(riders, filter); if (!item) return { deletedCount: 0 }; riders.delete(String(item._id)); return { deletedCount: 1 }; },
  };
  const userCollections = {
    findOne: (filter) => findOne(users, filter),
    updateOne: (filter, update) => updateOne(users, filter, update),
  };
  const parcelsCollections = {
    findOne: (filter) => findOne(parcels, filter),
    find: (filter = {}) => cursor([...parcels.values()].filter((item) => matches(item, filter))),
    updateOne: (filter, update) => updateOne(parcels, filter, update),
  };
  const admin = { auth: () => ({ verifyIdToken: async (token) => {
    const email = { riderA: "rider-a@example.test", riderB: "rider-b@example.test", applicant: "applicant@example.test", admin: "admin@example.test", managerA: "manager-a@example.test", managerB: "manager-b@example.test", merchant: "merchant@example.test" }[token];
    if (!email) throw new Error("invalid token");
    return { email };
  } }) };
  const dependencies = createRouteDependencies({
    admin,
    connectDB: async () => ({
      usersCollections: userCollections,
      userCollections,
      ridersCollections,
      parcelsCollections,
      merchantsCollections: { updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }) },
      hubManagersCollection: {
        findOne: (filter) => findOne(managers, filter),
        updateOne: (filter, update) => updateOne(managers, filter, update),
      },
      trackingLogsCollections: { insertOne: async () => ({ insertedId: "tracking" }) },
    }),
    withTransaction: async (callback) => {
      const snapshots = [users, riders, parcels, managers].map((map) =>
        new Map([...map.entries()].map(([key, value]) => [key, {
          ...value,
          _id: value._id,
          activeTasks: value.activeTasks ? structuredClone(value.activeTasks) : undefined,
          serviceCenters: value.serviceCenters ? { ...value.serviceCenters } : undefined,
        }])),
      );
      try {
        return await callback({});
      } catch (error) {
        [users, riders, parcels, managers].forEach((map, index) => {
          map.clear();
          for (const [key, value] of snapshots[index]) map.set(key, value);
        });
        throw error;
      }
    },
  });
  dependencies.logTracking = async () => {};
  dependencies.invalidateParcelStatusChange = () => {};
  const router = createRidersRouter(dependencies);
  delete process.env.STRIPE_SECRET;
  return { router, users, riders, managers, parcels, writes, dependencies };
}

function route(router, method, path) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} route exists`);
  return layer.route;
}

async function invoke(target, { token, params = {}, query = {}, body = {} } = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(bodyValue) { this.body = bodyValue; return this; },
  };
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, params, query, body };
  for (const layer of target.stack) {
    let advanced = false;
    let settle;
    const pending = new Promise((resolve, reject) => {
      settle = resolve;
      try {
        const result = layer.handle(req, res, (error) => {
          if (error) return reject(error);
          advanced = true;
          resolve();
        });
        if (result?.then) result.then(() => { if (!advanced && Object.hasOwn(res, "body")) resolve(); }, reject);
        else if (!advanced && Object.hasOwn(res, "body")) resolve();
      } catch (error) { reject(error); }
    });
    const originalSend = res.send.bind(res);
    res.send = (value) => { originalSend(value); settle(); return res; };
    await pending;
    if (Object.hasOwn(res, "body")) break;
  }
  return res;
}

for (const [name, token] of [["rider profile", "riderA"], ["rider status", "riderA"]]) {
  test(`${name} requires authenticated self identity`, async () => {
    const h = makeHarness();
    const target = name === "rider profile"
      ? route(h.router, "get", "/rider/:email")
      : route(h.router, "patch", "/rider/status/:email");
    const methodParams = { email: "rider-a@example.test" };
    assert.equal((await invoke(target, { params: methodParams })).statusCode, 401);
    assert.equal((await invoke(target, { token: "bad", params: methodParams })).statusCode, 401);
    assert.equal((await invoke(target, { token: "merchant", params: methodParams })).statusCode, 403);
    assert.equal((await invoke(target, { token, params: { email: "rider-b@example.test" }, body: { workStatus: "offline" } })).statusCode, 403);
  });
}

test("Rider profile response stays compatible and status accepts only frontend values", async () => {
  const h = makeHarness();
  const profile = await invoke(route(h.router, "get", "/rider/:email"), { token: "riderA", params: { email: "rider-a@example.test" } });
  assert.equal(profile.statusCode, 200);
  assert.equal(profile.body.riderData.email, "rider-a@example.test");
  assert.ok(Array.isArray(profile.body.assignedParcels));
  const target = route(h.router, "patch", "/rider/status/:email");
  const before = h.writes.length;
  assert.equal((await invoke(target, { token: "riderA", params: { email: "rider-a@example.test" }, body: { workStatus: "busy" } })).statusCode, 400);
  assert.equal(h.writes.length, before);
  assert.equal((await invoke(target, { token: "riderA", params: { email: "rider-a@example.test" }, body: { workStatus: "offline" } })).statusCode, 200);
  assert.equal(h.riders.get(RIDER_A_ID).workStatus, "offline");
  assert.equal(h.dependencies.riderCache.get("rider_rider-a%40example.test"), undefined);
});

test("Rider profile fails safely when the authenticated account has no Rider record", async () => {
  const h = makeHarness();
  h.riders.delete(RIDER_A_ID);
  const response = await invoke(route(h.router, "get", "/rider/:email"), {
    token: "riderA",
    params: { email: "rider-a@example.test" },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.body.success, false);
});

test("shared Rider listing preserves Admin filters and scopes Hub Manager and Rider results", async () => {
  const h = makeHarness();
  h.riders.set("rider-c", { _id: "rider-c", email: "rider-c@example.test", name: "Rider C", area: "B", status: "pending" });
  const target = route(h.router, "get", "/riders");
  assert.equal((await invoke(target)).statusCode, 401);
  assert.equal((await invoke(target, { token: "merchant" })).statusCode, 403);
  const adminAll = await invoke(target, { token: "admin" });
  assert.equal(adminAll.statusCode, 200);
  assert.equal(adminAll.body.length, 3);
  const adminPending = await invoke(target, { token: "admin", query: { status: "pending" } });
  assert.equal(adminPending.body.length, 1);
  assert.equal(adminPending.body[0].email, "rider-c@example.test");
  const managerOwn = await invoke(target, { token: "managerA", query: { area: "A" } });
  assert.equal(managerOwn.statusCode, 200);
  assert.ok(managerOwn.body.every((item) => item.area === "A"));
  const managerSubstitution = await invoke(target, { token: "managerA", query: { area: "B" } });
  assert.equal(managerSubstitution.statusCode, 403);
  const managerOmitted = await invoke(target, { token: "managerA", query: { status: "active" } });
  assert.ok(managerOmitted.body.every((item) => item.area === "A"));
  const riderOwn = await invoke(target, { token: "riderA", query: { email: "rider-a@example.test" } });
  assert.deepEqual(riderOwn.body.map((item) => item.email), ["rider-a@example.test"]);
  const riderSubstitution = await invoke(target, { token: "riderA", query: { email: "rider-b@example.test" } });
  assert.equal(riderSubstitution.statusCode, 403);
});

test("Hub Manager available Rider and return-house reads use the assigned hub", async () => {
  const h = makeHarness();
  h.parcels.set("return-a", { _id: "return-a", serviceCenters: { origin: "A" }, deliveryStatus: "receive-from-origin-warehouse" });
  h.parcels.set("return-b", { _id: "return-b", serviceCenters: { origin: "B" }, deliveryStatus: "receive-from-origin-warehouse" });
  const available = route(h.router, "get", "/riders/available/:areaName");
  assert.equal((await invoke(available, { params: { areaName: "A" } })).statusCode, 401);
  assert.equal((await invoke(available, { token: "merchant", params: { areaName: "A" } })).statusCode, 403);
  const own = await invoke(available, { token: "managerA", params: { areaName: "A" } });
  assert.equal(own.statusCode, 200);
  assert.deepEqual(Object.keys(own.body[0]).sort(), ["_id", "currentTasks", "name", "phone"]);
  assert.equal((await invoke(available, { token: "managerA", params: { areaName: "B" } })).statusCode, 403);
  const returnHouse = route(h.router, "get", "/warehouse/return-house/:hubName");
  assert.equal((await invoke(returnHouse, { token: "managerA", params: { hubName: "A" } })).body.returnList.length, 1);
  assert.equal((await invoke(returnHouse, { token: "managerA", params: { hubName: "B" } })).statusCode, 403);
  assert.equal((await invoke(returnHouse, { params: { hubName: "A" } })).statusCode, 401);
});

test("Hub Manager assignments enforce parcel and Rider hub, status, and database identity", async () => {
  const h = makeHarness();
  const pickup = route(h.router, "patch", "/parcels/assign-rider");
  h.dependencies.availableRidersCache.set("available_riders_a", ["cached"]);
  const body = { parcelId: PARCEL_A_ID, riderId: RIDER_A_ID, riderName: "Forged", riderEmail: "attacker@example.test", riderPhone: "000", trackingID: "FORGED" };
  const result = await invoke(pickup, { token: "managerA", body });
  assert.equal(result.statusCode, 200);
  const parcel = h.parcels.get(PARCEL_A_ID);
  assert.equal(parcel.pickupRider.name, "Rider A");
  assert.equal(parcel.pickupRider.email, "rider-a@example.test");
  assert.equal(parcel.pickupRider.phone, "111");
  assert.equal(parcel.pickupRider.id, RIDER_A_ID);
  assert.equal(h.riders.get(RIDER_A_ID).activeTasks[0].trackingID, "TA");
  assert.equal(h.dependencies.availableRidersCache.get("available_riders_a"), undefined);
  const parcelWrite = h.writes.findLast((write) => write.collection === h.parcels);
  const riderWrite = h.writes.findLast((write) => write.collection === h.riders);
  assert.equal(parcelWrite.filter["serviceCenters.origin"], "A");
  assert.equal(parcelWrite.filter.deliveryStatus, "parcel-created");
  assert.equal(String(riderWrite.filter._id), RIDER_A_ID);
  assert.equal(riderWrite.filter.email, "rider-a@example.test");
  assert.equal(riderWrite.filter.area, "A");
  const crossHubBefore = h.writes.length;
  assert.equal((await invoke(pickup, { token: "merchant", body })).statusCode, 403);
  assert.equal((await invoke(pickup, { token: "managerA", body: { ...body, parcelId: "bad-id" } })).statusCode, 400);
  assert.equal((await invoke(pickup, { token: "managerA", body: { ...body, parcelId: PARCEL_B_ID } })).statusCode, 403);
  assert.equal(h.writes.length, crossHubBefore);
  h.parcels.get(PARCEL_A_ID).deliveryStatus = "parcel-created";
  assert.equal((await invoke(pickup, { token: "managerA", body: { ...body, riderId: RIDER_B_ID } })).statusCode, 403);
  assert.equal(h.writes.length, crossHubBefore);
  h.parcels.get(PARCEL_A_ID).deliveryStatus = "assign-pickup-rider";
  assert.equal((await invoke(pickup, { token: "managerA", body })).statusCode, 409);
  assert.equal(h.writes.length, crossHubBefore);
  h.parcels.get(PARCEL_A_ID).deliveryStatus = "parcel-created";
  assert.equal(h.parcels.get(PARCEL_A_ID).pickupRider.id, RIDER_A_ID);

  const delivery = route(h.router, "patch", "/parcels/assign-delivery");
  h.parcels.get(PARCEL_B_ID).serviceCenters.destination = "B";
  const deliveryResult = await invoke(delivery, { token: "managerB", body: { ...body, parcelId: PARCEL_B_ID, riderId: RIDER_B_ID } });
  assert.equal(deliveryResult.statusCode, 200);
  assert.equal(h.parcels.get(PARCEL_B_ID).deliveryRider.email, "rider-b@example.test");
  assert.equal((await invoke(delivery, { token: "managerA", body: { ...body, parcelId: PARCEL_B_ID, riderId: RIDER_A_ID } })).statusCode, 403);
});

test("Rider application binds identity, allowlists fields, and prevents duplicates", async () => {
  const h = makeHarness();
  const target = route(h.router, "post", "/riders");
  assert.equal((await invoke(target, { body: { email: "applicant@example.test" } })).statusCode, 401);
  const created = await invoke(target, { token: "applicant", body: { email: "admin@example.test", name: "Applicant", area: "A", phone: "555", role: "admin", status: "active", currentTasks: 7 } });
  assert.equal(created.statusCode, 200);
  const applicant = h.riders.get(String(created.body.insertedId));
  assert.equal(applicant.email, "applicant@example.test");
  assert.equal(applicant.role, undefined);
  assert.equal(applicant.status, "pending");
  assert.equal(applicant.currentTasks, 0);
  assert.equal(h.users.get("applicant@example.test").role, "pending-rider");
  assert.equal((await invoke(target, { token: "applicant", body: { name: "Duplicate" } })).body.message, "This email already used for rider!");
  assert.equal(h.users.get("admin@example.test").role, "admin");
  assert.equal((await invoke(target, { token: "admin", body: { name: "Privileged account" } })).statusCode, 409);
  assert.equal(h.users.get("admin@example.test").role, "admin");
});

test("Admin approval uses the stored Rider email and delete route remains Admin-protected", async () => {
  const h = makeHarness();
  const approval = route(h.router, "patch", "/riders/:id");
  assert.equal((await invoke(approval, { params: { id: RIDER_A_ID }, body: { status: "approved" } })).statusCode, 401);
  assert.equal((await invoke(approval, { token: "riderA", params: { id: RIDER_A_ID }, body: { status: "approved" } })).statusCode, 403);
  h.users.get("rider-a@example.test").role = "pending-rider";
  h.users.get("rider-b@example.test").role = "user";
  const result = await invoke(approval, { token: "admin", params: { id: RIDER_A_ID }, body: { status: "approved", workStatus: "available", email: "rider-b@example.test" } });
  assert.equal(result.statusCode, 200);
  assert.equal(h.users.get("rider-a@example.test").role, "rider");
  assert.equal(h.users.get("rider-b@example.test").role, "user");
  h.users.delete("rider-a@example.test");
  const missingAccount = await invoke(approval, { token: "admin", params: { id: RIDER_A_ID }, body: { status: "rejected", workStatus: "offline" } });
  assert.equal(missingAccount.statusCode, 404);
  assert.equal(h.riders.get(RIDER_A_ID).status, "approved");
  const deletion = route(h.router, "delete", "/riders/:id");
  assert.equal((await invoke(deletion, { params: { id: RIDER_B_ID } })).statusCode, 401);
  assert.equal((await invoke(deletion, { token: "riderA", params: { id: RIDER_B_ID } })).statusCode, 403);
  assert.equal((await invoke(deletion, { token: "admin", params: { id: RIDER_B_ID } })).statusCode, 200);
});
