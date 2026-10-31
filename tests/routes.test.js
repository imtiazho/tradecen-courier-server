const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const registerRoutes = require("../src/routes");

const expectedRoutes = [
  "GET /users",
  "GET /user/:email",
  "GET /user/:email/role",
  "PATCH /users/update/:email",
  "POST /users",
  "PATCH /users/verify-status/:email",
  "PATCH /users/make-hub-manager",
  "GET /users/hub-managers",
  "GET /parcels/incoming/:hubName",
  "GET /parcels/pickups/:hubName",
  "GET /warehouse/sorting-house/:hubName",
  "GET /parcels/out-for-delivery/:hubName",
  "GET /parcels/hub-delivered/:hubName",
  "GET /rider/:email",
  "PATCH /rider/status/:email",
  "PATCH /riders/hold-parcel/update",
  "POST /riders",
  "GET /riders",
  "GET /riders/available/:areaName",
  "PATCH /riders/:id",
  "PATCH /parcels/assign-rider",
  "PATCH /parcels/assign-delivery",
  "PATCH /parcels/assign-return-delivery",
  "PATCH /riders/complete-return-delivered/update",
  "PATCH /riders/complete-pickup/update",
  "PATCH /riders/return-req/update",
  "PATCH /parcels/return-hub/received/:parcelId",
  "PATCH /hub/dispatch-return-to-origin/:parcelId",
  "PATCH /parcels/return-origin-hub/received/:parcelId",
  "GET /warehouse/return-house/:hubName",
  "PATCH /riders/complete-delivered/update",
  "DELETE /riders/:id",
  "GET /all-merchants",
  "GET /area-merchant/:hubName",
  "POST /merchants",
  "GET /merchant/:email",
  "PATCH /merchant-update/:email",
  "GET /payment-payout-summary/:email",
  "POST /request-payout",
  "PATCH /approve-payout/:id",
  "GET /all-payouts",
  "GET /parcels",
  "GET /parcel/:parcelID",
  "GET /late-invoices/:email",
  "GET /parcels/unpaid/:email",
  "GET /parcels/status/:email",
  "GET /parcels/stats/:email",
  "GET /revenue/stats/:email",
  "GET /tracking/:id",
  "POST /parcels",
  "DELETE /parcel/:id",
  "PATCH /parcels/dispatch/:id",
  "PATCH /parcels/dest-hub/received/:id",
  "PATCH /parcels/origin-hub/received/:id",
  "GET /hub-hand-cash/:hubName",
  "GET /hub-profit-metrics/:hubName",
  "GET /hub-aging-status/:hubName",
  "GET /hub-efficiency-flow/:hubName",
  "POST /deposit-HQ/:hubName",
  "GET /hub-deposit-history",
  "PATCH /approve-deposit/:id",
  "GET /master-admin/main-dashboard",
  "GET /",
  "POST /payment-checkout",
  "PATCH /verify-payment",
  "POST /send-otp",
  "POST /verify-otp",
  "POST /reset-password",
];

test("all legacy routes are registered once across the workflow routers", () => {
  const middleware = (name) => {
    const handler = () => {};
    handler.auditName = name;
    return handler;
  };
  const dependencies = {
    verifyFireBaseToken: middleware("verifyFireBaseToken"),
    verifyRoles: (...roles) => middleware(`verifyRoles(${roles.join(",")})`),
    verifyOwner: middleware("verifyOwner"),
    verifyAdminToken: middleware("verifyAdminToken"),
    verifyMerchantToken: middleware("verifyMerchantToken"),
    verifyRiderToken: middleware("verifyRiderToken"),
    verifyHubManagerToken: middleware("verifyHubManagerToken"),
  };

  const app = express();
  registerRoutes(app, dependencies);

  function collectRoutes(stack) {
    return stack.flatMap((layer) => {
      if (layer.route) {
        const middlewareNames = layer.route.stack
          .map((routeLayer) => routeLayer.handle.auditName)
          .filter(Boolean);
        return Object.keys(layer.route.methods)
          .filter((method) => layer.route.methods[method])
          .map((method) => ({
            key: `${method.toUpperCase()} ${layer.route.path}`,
            middleware: middlewareNames,
          }));
      }
      return layer.handle?.stack ? collectRoutes(layer.handle.stack) : [];
    });
  }

  const registered = collectRoutes(app.router.stack);
  const registeredRoutes = registered.map(({ key }) => key);

  assert.equal(registeredRoutes.length, 68);
  assert.equal(new Set(registeredRoutes).size, registeredRoutes.length);
  assert.deepEqual([...registeredRoutes].sort(), [...expectedRoutes].sort());

  const routePatterns = registered.map(({ key }) => {
    const [method, routePath] = key.split(" ");
    return { method, segments: routePath.split("/").filter(Boolean), routePath };
  });
  for (let i = 0; i < routePatterns.length; i += 1) {
    for (let j = i + 1; j < routePatterns.length; j += 1) {
      const first = routePatterns[i];
      const second = routePatterns[j];
      if (first.method !== second.method || first.segments.length !== second.segments.length) continue;
      const canMatchSamePath = first.segments.every((segment, index) =>
        segment === second.segments[index] || segment.startsWith(":") || second.segments[index].startsWith(":"),
      );
      assert.equal(
        canMatchSamePath,
        false,
        `same-method routes can shadow each other: ${first.routePath} and ${second.routePath}`,
      );
    }
  }

  const expectedMiddleware = {
    "GET /payment-payout-summary/:email": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "POST /request-payout": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "GET /user/:email/role": ["verifyFireBaseToken", "verifyOwner"],
    "PATCH /users/make-hub-manager": ["verifyFireBaseToken", "verifyAdminToken"],
    "GET /parcels/pickups/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /warehouse/sorting-house/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /parcels/out-for-delivery/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /parcels/hub-delivered/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "PATCH /riders/hold-parcel/update": ["verifyFireBaseToken", "verifyRiderToken"],
    "GET /riders": ["verifyFireBaseToken", "verifyRoles(admin,hub-manager,rider)"],
    "GET /riders/available/:areaName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "PATCH /riders/:id": ["verifyFireBaseToken", "verifyAdminToken"],
    "PATCH /parcels/assign-rider": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "PATCH /parcels/assign-delivery": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "PATCH /riders/complete-pickup/update": ["verifyFireBaseToken", "verifyRiderToken"],
    "PATCH /riders/complete-delivered/update": ["verifyFireBaseToken", "verifyRiderToken"],
    "GET /all-merchants": ["verifyFireBaseToken", "verifyAdminToken"],
    "GET /area-merchant/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /merchant/:email": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "PATCH /merchant-update/:email": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "GET /parcels": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "GET /late-invoices/:email": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "GET /parcels/stats/:email": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "GET /revenue/stats/:email": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "POST /parcels": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "DELETE /parcel/:id": ["verifyFireBaseToken", "verifyMerchantToken", "verifyOwner"],
    "PATCH /parcels/dispatch/:id": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "PATCH /parcels/dest-hub/received/:id": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "PATCH /parcels/origin-hub/received/:id": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /hub-profit-metrics/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /hub-aging-status/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /hub-efficiency-flow/:hubName": ["verifyFireBaseToken", "verifyHubManagerToken"],
    "GET /hub-deposit-history": ["verifyFireBaseToken", "verifyRoles(hub-manager,admin)"],
    "PATCH /approve-deposit/:id": ["verifyFireBaseToken", "verifyAdminToken"],
  };
  for (const { key, middleware: actual } of registered) {
    assert.deepEqual(
      actual,
      expectedMiddleware[key] || [],
      `middleware order changed for ${key}`,
    );
  }
});

test("every router dependency is exported by the shared dependency factory", () => {
  const routesDirectory = path.join(__dirname, "..", "src", "routes");
  const factory = fs.readFileSync(path.join(routesDirectory, "dependencies.js"), "utf8");
  const returnedNames = new Set(
    factory.match(/return \{ ([^}]+) \};/s)[1].split(",").map((name) => name.trim()),
  );

  for (const file of fs.readdirSync(routesDirectory).filter((name) =>
    name.endsWith(".js") && name !== "dependencies.js" && name !== "index.js",
  )) {
    const source = fs.readFileSync(path.join(routesDirectory, file), "utf8");
    const injectedNames = source
      .match(/const \{ ([^}]+) \} = dependencies;/)[1]
      .split(",")
      .map((name) => name.trim());
    assert.deepEqual(
      injectedNames.filter((name) => !returnedNames.has(name)),
      [],
      `${file} has injected dependencies missing from the factory`,
    );
  }
});
