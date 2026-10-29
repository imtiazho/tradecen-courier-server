const assert = require("node:assert/strict");
const { test } = require("node:test");

const app = require("../src/app");

test("Express app keeps CORS and JSON body parsing configured", () => {
  const middlewareNames = app.router.stack.map((layer) => layer.name);

  assert.deepEqual(middlewareNames, ["corsMiddleware", "jsonParser"]);
});
