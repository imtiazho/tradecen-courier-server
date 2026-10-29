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
  const middleware = () => {};
  const dependencies = {
    verifyFireBaseToken: middleware,
    verifyRoles: () => middleware,
    verifyOwner: middleware,
    verifyAdminToken: middleware,
    verifyMerchantToken: middleware,
    verifyRiderToken: middleware,
    verifyHubManagerToken: middleware,
  };

  const app = express();
  registerRoutes(app, dependencies);

  function collectRoutes(stack) {
    return stack.flatMap((layer) => {
      if (layer.route) {
        return Object.keys(layer.route.methods)
          .filter((method) => layer.route.methods[method])
          .map((method) => `${method.toUpperCase()} ${layer.route.path}`);
      }
      return layer.handle?.stack ? collectRoutes(layer.handle.stack) : [];
    });
  }

  const registeredRoutes = collectRoutes(app.router.stack);

  assert.equal(registeredRoutes.length, 68);
  assert.equal(new Set(registeredRoutes).size, registeredRoutes.length);
  assert.deepEqual([...registeredRoutes].sort(), [...expectedRoutes].sort());
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
