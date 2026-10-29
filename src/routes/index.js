const routeModules = [
  require("./users"),
  require("./hub-parcels"),
  require("./riders"),
  require("./merchants"),
  require("./payouts"),
  require("./parcel-queries"),
  require("./hub-finance"),
  require("./payments"),
  require("./otp"),
];

function registerRoutes(app, dependencies) {
  for (const createRouter of routeModules) {
    app.use(createRouter(dependencies));
  }
}

module.exports = registerRoutes;
