const app = require("./src/app");
const { admin } = require("./src/config/firebase");
const { connectDB, withTransaction } = require("./src/config/database");
const createRouteDependencies = require("./src/routes/dependencies");
const registerRoutes = require("./src/routes");

const dependencies = createRouteDependencies({ admin, connectDB, withTransaction });
registerRoutes(app, dependencies);

module.exports = app;
