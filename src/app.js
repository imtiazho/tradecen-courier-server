require("dotenv").config();

const express = require("express");
const cors = require("cors");
const dns = require("dns");

const app = express();

// Keep the existing DNS resolver configuration and middleware behavior.
dns.setServers(["8.8.8.8", "8.8.4.4"]);
app.use(cors());
app.use(express.json());

module.exports = app;
