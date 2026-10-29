const assert = require("node:assert/strict");
const express = require("express");
const { test } = require("node:test");

const app = require("../src/app");
const registerOtpRoutes = require("../src/routes/otp");

test("Express app keeps CORS and JSON body parsing configured", () => {
  const middlewareNames = app.router.stack.map((layer) => layer.name);

  assert.deepEqual(middlewareNames, ["corsMiddleware", "jsonParser"]);
});

test("OTP route module registers its existing POST endpoints in order", () => {
  const routesApp = express();
  const admin = { auth: () => ({}), firestore: () => ({}) };
  const transporter = { sendMail: async () => {} };

  registerOtpRoutes(routesApp, { admin, transporter });

  const routes = routesApp.router.stack.map(({ route }) => ({
    path: route.path,
    methods: Object.keys(route.methods).filter((method) => route.methods[method]),
  }));
  assert.deepEqual(routes, [
    { path: "/send-otp", methods: ["post"] },
    { path: "/verify-otp", methods: ["post"] },
    { path: "/reset-password", methods: ["post"] },
  ]);
});
