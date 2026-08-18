process.env.UV_THREADPOOL_SIZE = 128;
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const dns = require("dns");
const nodemailer = require("nodemailer");
const NodeCache = require("node-cache");

class VersionedCache {
  constructor(options) {
    this.store = new NodeCache(options);
    this.versions = new Map();
  }

  _version(owner) {
    return this.versions.get(owner) || 1;
  }

  _buildKey(owner, parts) {
    return `v${this._version(owner)}:${owner}:${parts.join("|")}`;
  }

  get(owner, parts) {
    return this.store.get(this._buildKey(owner, parts));
  }

  set(owner, parts, value) {
    return this.store.set(this._buildKey(owner, parts), value);
  }

  bump(owner) {
    this.versions.set(owner, this._version(owner) + 1);
  }
}

const trackingCache = new NodeCache({ stdTTL: 10, checkperiod: 12 });
const usersCache = new VersionedCache({ stdTTL: 10, checkperiod: 12 });
const userCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const userRoleCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const managerCache = new VersionedCache({ stdTTL: 10, checkperiod: 60 });
const incomingParcelsCache = new NodeCache({ stdTTL: 10, checkperiod: 60 });
const merchantParcelsCache = new VersionedCache({
  stdTTL: 30,
  checkperiod: 60,
});
const pickupCache = new NodeCache({ stdTTL: 180, checkperiod: 60 });
const sortingCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const outForDeliveryCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const hubDeliveredCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const riderCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });
const ridersCache = new VersionedCache({ stdTTL: 60, checkperiod: 120 });
const availableRidersCache = new NodeCache({ stdTTL: 15, checkperiod: 30 });
const returnWarehouseCache = new NodeCache({ stdTTL: 20, checkperiod: 40 });
const allMerchantsCache = new NodeCache({ stdTTL: 20, checkperiod: 40 });
const merchantsAreaWiseCache = new NodeCache({ stdTTL: 20, checkperiod: 40 });
const targetedMerchantCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });
const payoutSummaryCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const allPayoutsCache = new NodeCache({ stdTTL: 20, checkperiod: 60 });
const parcelDetailCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const lateInvoicesCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const merchantUnpaidCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
const parcelsStatusWiseCache = new VersionedCache({
  stdTTL: 30,
  checkperiod: 60,
});
const parcelStatsCache = new NodeCache({ stdTTL: 10, checkperiod: 60 });
const revenueStatsCache = new VersionedCache({ stdTTL: 10, checkperiod: 60 });
const hubHandCashCache = new NodeCache({ stdTTL: 10, checkperiod: 60 });
const hubProfitCache = new NodeCache({ stdTTL: 10, checkperiod: 60 });
const hubAgingCache = new NodeCache({ stdTTL: 180, checkperiod: 60 });
const hubEfficiencyCache = new NodeCache({ stdTTL: 180, checkperiod: 60 });
const depositHistoryCache = new VersionedCache({
  stdTTL: 180,
  checkperiod: 60,
});
const mainDashboardCache = new NodeCache({ stdTTL: 120, checkperiod: 60 });

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");
const { stat } = require("fs");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

dns.setServers(["8.8.8.8", "8.8.4.4"]);

app.use(cors());
app.use(express.json());

const verifyFireBaseToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }
};

const verifyRoles = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      const email = req.decoded_email;
      const { userCollections } = await connectDB();
      const user = await userCollections.findOne({ email });

      if (!user) {
        return res
          .status(404)
          .send({ success: false, message: "User not found" });
      }
      if (!allowedRoles.includes(user.role)) {
        return res.status(403).send({
          success: false,
          message:
            "Forbidden Access: You do not have permission for this resource",
        });
      }
      next();
    } catch (error) {
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  };
};

const verifyOwner = (req, res, next) => {
  const requestedEmail = req.params.email || req.query.email || req.body.email;
  const decodedEmail = req.decoded_email;
  if (!requestedEmail) {
    return res
      .status(400)
      .send({ success: false, message: "Email parameter is required" });
  }
  if (requestedEmail !== decodedEmail) {
    return res
      .status(403)
      .send({
        success: false,
        message: "Forbidden: You cannot access other user's data",
      });
  }
  next();
};

const verifyAdminToken = async (req, res, next) => {
  const email = req.decoded_email;
  const { userCollections } = await connectDB();
  const user = await userCollections.findOne({ email });
  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyMerchantToken = async (req, res, next) => {
  const email = req.decoded_email;
  const { userCollections } = await connectDB();
  const user = await userCollections.findOne({ email });
  if (!user || user.role !== "merchant") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyRiderToken = async (req, res, next) => {
  const email = req.decoded_email;
  const { userCollections } = await connectDB();
  const user = await userCollections.findOne({ email });
  if (!user || user.role !== "rider") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyHubManagerToken = async (req, res, next) => {
  const email = req.decoded_email;
  const { userCollections } = await connectDB();
  const user = await userCollections.findOne({ email });
  if (!user || user.role !== "hub-manager") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ab3rgue.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  maxPoolSize: 200,
  minPoolSize: 10,
  maxIdleTimeMS: 1000,
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db,
  userCollections,
  ridersCollections,
  merchantsCollections,
  parcelsCollections,
  paymentCollections,
  hubManagersCollection,
  trackingLogsCollections,
  payoutsCollections,
  hqPaymentsCollections;

async function connectDB() {
  if (db)
    return {
      userCollections,
      ridersCollections,
      merchantsCollections,
      parcelsCollections,
      paymentCollections,
      hubManagersCollection,
      trackingLogsCollections,
      payoutsCollections,
      hqPaymentsCollections,
    };

  await client.connect();
  db = client.db("tradeCen_DB");
  userCollections = db.collection("users");
  ridersCollections = db.collection("riders");
  merchantsCollections = db.collection("merchants");
  parcelsCollections = db.collection("parcels");
  paymentCollections = db.collection("payments");
  hubManagersCollection = db.collection("hubManagers");
  trackingLogsCollections = db.collection("trackingLogs");
  payoutsCollections = db.collection("payoutsCollections");
  hqPaymentsCollections = db.collection("hqPaymentsCollections");

  await trackingLogsCollections.createIndex({ trackingID: 1, createdAt: -1 });
  await userCollections.createIndex({ email: 1 }, { unique: true });
  await userCollections.createIndex({ email: 1, role: 1 });
  await hubManagersCollection.createIndex({ email: 1 }, { unique: true });
  await hubManagersCollection.createIndex({ region: 1, district: 1 });
  await parcelsCollections.createIndex({
    "serviceCenters.origin": 1,
    deliveryStatus: 1,
  });
  await parcelsCollections.createIndex({
    "serviceCenters.destination": 1,
    deliveryStatus: 1,
  });
  await parcelsCollections.createIndex({
    "senderInfo.area": 1,
    deliveryStatus: 1,
    inCity: 1,
  });
  await parcelsCollections.createIndex({
    "receiverInfo.area": 1,
    deliveryStatus: 1,
  });
  await parcelsCollections.createIndex({
    "deliveryRider.email": 1,
    deliveryStatus: 1,
    createdAt: -1,
  });
  await parcelsCollections.createIndex({
    "pickupRider.email": 1,
    deliveryStatus: 1,
    createdAt: -1,
  });
  await parcelsCollections.createIndex({
    "deliveryRider.email": 1,
    "deliveryRider.assignedAt": 1,
    deliveryStatus: 1,
  });
  await parcelsCollections.createIndex({
    "pickupRider.email": 1,
    "pickupRider.assignedAt": 1,
    deliveryStatus: 1,
  });
  await ridersCollections.createIndex({ area: 1, status: 1, workStatus: 1 });
  await ridersCollections.createIndex({ email: 1 });
  await ridersCollections.createIndex({
    area: 1,
    workStatus: 1,
    currentTasks: 1,
  });
  await merchantsCollections.createIndex({ area: 1 });
  await merchantsCollections.createIndex({ email: 1 });
  await parcelsCollections.createIndex({
    "senderInfo.email": 1,
    deliveryStatus: 1,
    merchantRevenueStatus: 1,
  });
  await payoutsCollections.createIndex({ email: 1, payoutStatus: 1 });
  await payoutsCollections.createIndex({ email: 1, requestedAt: -1 });
  await payoutsCollections.createIndex({ payoutStatus: 1, requestedAt: -1 });
  await parcelsCollections.createIndex({
    "senderInfo.email": 1,
    deliveryStatus: 1,
    createdAt: -1,
  });
  await parcelsCollections.createIndex({
    "senderInfo.email": 1,
    deliveryChargeStatus: 1,
    deliveryStatus: 1,
  });
  await parcelsCollections.createIndex({
    "senderInfo.email": 1,
    deliveryChargeStatus: 1,
    createdAt: -1,
  });
  await parcelsCollections.createIndex({
    "serviceCenters.destination": 1,
    deliveryStatus: 1,
    isDepositedToHQ: 1,
  });
  await parcelsCollections.createIndex({
    "serviceCenters.destination": 1,
    deliveryStatus: 1,
    createdAt: 1,
  });
  await parcelsCollections.createIndex({
    "serviceCenters.origin": 1,
    deliveryStatus: 1,
    createdAt: 1,
  });
  await hqPaymentsCollections.createIndex({
    hubName: 1,
    status: 1,
    createdAt: -1,
  });
  await parcelsCollections.createIndex({ deliveryStatus: 1 });
  await parcelsCollections.createIndex({
    status: 1,
    revMethod: 1,
    isDepositedToHQ: 1,
  });
  await parcelsCollections.createIndex({ createdAt: -1 });
  await ridersCollections.createIndex({ currentTasks: 1 });

  return {
    userCollections,
    ridersCollections,
    merchantsCollections,
    parcelsCollections,
    paymentCollections,
    hubManagersCollection,
    trackingLogsCollections,
    payoutsCollections,
    hqPaymentsCollections,
  };
}

/* ----- Helpers ------ */
const logTracking = async (parcel, status) => {
  const { trackingLogsCollections } = await connectDB();
  const log = {
    trackingID: parcel.trackingID,
    parcelName: parcel.parcelName,
    codAmount: parcel.codAmount,
    merchantName: parcel.senderInfo.name,
    receiverName: parcel.receiverInfo.name,
    deliveryStatus: status,
    details: `${status.split("-").join(" ")} for this parcel.`,
    createdAt: new Date(),
  };
  return await trackingLogsCollections.insertOne(log);
};

function invalidateParcelStatusChange({
  trackingID,
  senderEmail,
  originHub,
  destinationHub,
  parcelId,
}) {
  if (trackingID) trackingCache.del(trackingID);
  if (parcelId) parcelDetailCache.del(`parcel_${parcelId}`);
  if (senderEmail) {
    merchantParcelsCache.bump(senderEmail);
    parcelsStatusWiseCache.bump(senderEmail);
  }
  if (originHub) {
    incomingParcelsCache.del(`incoming_parcels_${originHub}`);
    pickupCache.del(`pickup_parcels_${originHub}`);
    sortingCache.del(`sorting_house_${originHub}`);
    hubAgingCache.del(`hub_aging_status_${originHub}`);
  }
  if (destinationHub) {
    incomingParcelsCache.del(`incoming_parcels_${destinationHub}`);
    outForDeliveryCache.del(`out_for_delivery_${destinationHub}`);
    hubDeliveredCache.del(`hub_delivered_${destinationHub}`);
    sortingCache.del(`sorting_house_${destinationHub}`);
    hubAgingCache.del(`hub_aging_status_${destinationHub}`);
    hubEfficiencyCache.del(`hub_efficiency_flow_${destinationHub}`);
  }
}

/* ---- EXPRESS ROUTES START HERE ----*/

/*---- User Related APIs ----*/
app.get("/users", async (req, res) => {
  try {
    const searchText = req.query.searchText || "";
    const role = req.query.role || "";

    const cachedData = usersCache.get("global", [searchText, role]);
    if (cachedData) {
      return res
        .status(200)
        .send({ success: true, data: cachedData, source: "cache" });
    }

    const { userCollections } = await connectDB();
    const query = {};
    if (searchText) {
      query.$or = [
        { displayName: { $regex: searchText, $options: "i" } },
        { email: { $regex: searchText, $options: "i" } },
      ];
    }
    if (role) query.role = role;

    const result = await userCollections
      .find(query)
      .sort({ createdAt: -1 })
      .limit(10)
      .project({ email: 1, displayName: 1, role: 1 })
      .toArray();

    usersCache.set("global", [searchText, role], result);
    res.status(200).send({ success: true, data: result, source: "database" });
  } catch (error) {
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.get("/user/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const cacheKey = `user_${email}`;
    const cachedUser = userCache.get(cacheKey);
    if (cachedUser) return res.send(cachedUser);

    const { userCollections } = await connectDB();
    const user = await userCollections.findOne(
      { email: email },
      {
        projection: {
          _id: 0,
          role: 1,
          isOnboarded: 1,
          email: 1,
          displayName: 1,
          photoURL: 1,
          createdAt: 1,
        },
      },
    );
    if (!user) {
      return res
        .status(404)
        .send({ success: false, message: "User not found in database" });
    }
    userCache.set(cacheKey, user);
    res.send(user);
  } catch (error) {
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.get(
  "/user/:email/role",
  verifyFireBaseToken,
  verifyOwner,
  async (req, res) => {
    try {
      const cacheKey = `user_role_${req.params.email}`;
      const cachedRole = userRoleCache.get(cacheKey);
      if (cachedRole) return res.send({ role: cachedRole });

      const { userCollections } = await connectDB();
      const user = await userCollections.findOne({ email: req.params.email });
      userRoleCache.set(cacheKey, user.role);
      res.send({ role: user.role });
    } catch (error) {
      console.error("API Error Stack:", error);
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  },
);

app.patch("/users/update/:email", async (req, res) => {
  try {
    const { userCollections } = await connectDB();
    const email = req.params.email;
    const result = await userCollections.updateOne(
      { email },
      { $set: { ...req.body } },
    );

    userCache.del(`user_${email}`);
    userRoleCache.del(`user_role_${email}`);
    usersCache.bump("global");

    res.send(result);
  } catch (error) {
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.post("/users", async (req, res) => {
  try {
    const { userCollections } = await connectDB();
    const user = req.body;
    const isExist = await userCollections.findOne({ email: user.email });
    if (isExist) return res.send({ message: "User already exists" });

    const result = await userCollections.insertOne(user);
    usersCache.bump("global");
    res.send(result);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.patch("/users/verify-status/:email", async (req, res) => {
  try {
    const { userCollections } = await connectDB();
    const email = req.params.email;
    const result = await userCollections.updateOne(
      { email },
      { $set: { isOnboarded: true } },
    );

    userCache.del(`user_${email}`);
    userRoleCache.del(`user_role_${email}`);
    usersCache.bump("global");

    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.patch(
  "/users/make-hub-manager",
  verifyFireBaseToken,
  verifyAdminToken,
  async (req, res) => {
    try {
      const data = req.body;
      const { email, region, district, hubName } = data;

      const userFilter = { email: email };
      const updateRole = { $set: { role: "hub-manager" } };
      const updateResult = await userCollections.updateOne(
        userFilter,
        updateRole,
      );

      if (updateResult.modifiedCount === 0) {
        return res
          .status(404)
          .send({
            success: false,
            message: "User not found or role already updated",
          });
      }

      const userProfile = await userCollections.findOne({ email: email });
      const hubManagerDoc = {
        userId: userProfile._id,
        name: userProfile.displayName,
        email: email,
        photoURL: userProfile.photoURL || "",
        region,
        district,
        hubName,
        assignedAt: new Date(),
        status: "active",
      };
      const insertResult = await hubManagersCollection.insertOne(hubManagerDoc);

      if (insertResult.insertedId) {
        userCache.del(`user_${email}`);
        userRoleCache.del(`user_role_${email}`);
        usersCache.bump("global");
        managerCache.bump("global");

        res.send({
          success: true,
          message: "User promoted and added to Hub Managers collection",
        });
      }
    } catch (error) {
      console.error("Error adding hub manager:", error);
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

/* ---- Managers ---- */
app.get("/users/hub-managers", async (req, res) => {
  try {
    const { region, district, email } = req.query;
    const cachedData = managerCache.get("global", [
      email || "all",
      region || "all",
      district || "all",
    ]);
    if (cachedData) return res.status(200).send(cachedData);

    let query = {};
    if (email) query.email = email;
    if (region) query.region = region;
    if (district) query.district = district;

    const result = await hubManagersCollection.find(query).toArray();
    const finalData = email ? result[0] || null : result;

    managerCache.set(
      "global",
      [email || "all", region || "all", district || "all"],
      finalData,
    );
    res.status(200).send(finalData);
  } catch (error) {
    console.error("Error fetching managers:", error);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.get("/parcels/incoming/:hubName", async (req, res) => {
  try {
    const hubName = req.params.hubName;
    const cacheKey = `incoming_parcels_${hubName}`;
    const cachedData = incomingParcelsCache.get(cacheKey);
    if (cachedData) return res.status(200).send(cachedData);

    const { parcelsCollections } = await connectDB();
    const query = {
      $or: [
        { "serviceCenters.origin": hubName, deliveryStatus: "parcel-created" },
        {
          "serviceCenters.origin": hubName,
          deliveryStatus: "assign-pickup-rider",
        },
        { "serviceCenters.destination": hubName, deliveryStatus: "in-transit" },
        {
          "serviceCenters.origin": hubName,
          deliveryStatus: "return-in-transit-to-origin",
        },
      ],
    };
    const result = await parcelsCollections.find(query).toArray();
    incomingParcelsCache.set(cacheKey, result);
    res.send(result);
  } catch (error) {
    res
      .status(500)
      .send({
        message: "Error fetching incoming parcels",
        error: error.message,
      });
  }
});

app.get(
  "/parcels/pickups/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const hubName = req.params.hubName;
      const cacheKey = `pickup_parcels_${hubName}`;
      const cachedData = pickupCache.get(cacheKey);
      if (cachedData) return res.status(200).send(cachedData);

      const { parcelsCollections } = await connectDB();
      const query = {
        "serviceCenters.origin": hubName,
        deliveryStatus: "picked-up",
      };
      const result = await parcelsCollections.find(query).toArray();
      pickupCache.set(cacheKey, result);
      res.send(result);
    } catch (error) {
      res
        .status(500)
        .send({
          message: "Error fetching incoming parcels",
          error: error.message,
        });
    }
  },
);

app.get(
  "/warehouse/sorting-house/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `sorting_house_${hubName}`;
      const cachedData = sortingCache.get(cacheKey);
      if (cachedData) return res.status(200).send(cachedData);

      const { parcelsCollections } = await connectDB();
      const dispatchList = await parcelsCollections
        .find({
          deliveryStatus: "reached-origin-warehouse",
          "senderInfo.area": hubName,
          inCity: false,
        })
        .toArray();
      const deliveryList = await parcelsCollections
        .find({
          $or: [
            {
              deliveryStatus: "reached-destination-warehouse",
              "receiverInfo.area": hubName,
            },
            {
              deliveryStatus: "reached-origin-warehouse",
              "receiverInfo.area": hubName,
            },
          ],
        })
        .toArray();

      const payload = {
        dispatchList,
        deliveryList,
        total: dispatchList.length + deliveryList.length,
      };
      sortingCache.set(cacheKey, payload);
      res.send(payload);
    } catch (error) {
      res.status(500).send({ message: "Error sorting parcels" });
    }
  },
);

app.get(
  "/parcels/out-for-delivery/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `out_for_delivery_${hubName}`;
      const cachedData = outForDeliveryCache.get(cacheKey);
      if (cachedData) return res.status(200).send(cachedData);

      const { parcelsCollections } = await connectDB();
      const query = {
        "serviceCenters.destination": hubName,
        deliveryStatus: { $in: ["assign-delivery-rider", "hold"] },
      };
      const result = await parcelsCollections.find(query).toArray();
      outForDeliveryCache.set(cacheKey, result);
      res.send(result);
    } catch (error) {
      res.status(500).send({ message: "Error out for delivery parcels" });
    }
  },
);

app.get(
  "/parcels/hub-delivered/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `hub_delivered_${hubName}`;
      const cachedData = hubDeliveredCache.get(cacheKey);
      if (cachedData) return res.status(200).send(cachedData);

      const { parcelsCollections } = await connectDB();
      const query = {
        "serviceCenters.destination": hubName,
        deliveryStatus: "delivered",
      };
      const result = await parcelsCollections
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      hubDeliveredCache.set(cacheKey, result);
      res.send(result);
    } catch (error) {
      res.status(500).send({ message: "Error fetching delivered parcels" });
    }
  },
);

/*---- Rider Related APIs Start ----*/
app.get("/rider/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const cacheKey = `rider_${email}`;
    const cachedData = riderCache.get(cacheKey);
    if (cachedData) return res.status(200).send(cachedData);

    const { ridersCollections, parcelsCollections } = await connectDB();
    const riderData = await ridersCollections.findOne({ email: email });
    if (!riderData) {
      return res
        .status(404)
        .send({ success: false, message: "Rider not found in TradeCen" });
    }

    const assignedParcels = riderData.activeTasks || [];
    const holdUpParcels = assignedParcels.filter((p) => p && p.isHold === true);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const allHandledParcels = await parcelsCollections
      .find({
        $or: [{ "deliveryRider.email": email }, { "pickupRider.email": email }],
        deliveryStatus: { $in: ["picked-up", "delivered"] },
      })
      .sort({ createdAt: -1 })
      .toArray();

    const todaysParcels = await parcelsCollections
      .find({
        $or: [
          {
            "deliveryRider.email": email,
            "deliveryRider.assignedAt": {
              $gte: startOfToday,
              $lte: endOfToday,
            },
          },
          {
            "pickupRider.email": email,
            "pickupRider.assignedAt": { $gte: startOfToday, $lte: endOfToday },
          },
        ],
        deliveryStatus: {
          $in: [
            "delivered",
            "assign-pickup-rider",
            "picked-up",
            "assign-delivery-rider",
          ],
        },
      })
      .toArray();

    const todayDeliveryCompleteParcels = (todaysParcels || []).filter(
      (p) => p.deliveryStatus === "delivered",
    );
    const todayPickUpCompleteParcels = (todaysParcels || []).filter(
      (p) => p.deliveryStatus === "picked-up",
    );
    const allDeliveryCompleteParcels = (allHandledParcels || []).filter(
      (p) => p.deliveryStatus === "delivered",
    );
    const allPickUpCompleteParcels = (allHandledParcels || []).filter(
      (p) => p.deliveryStatus === "picked-up",
    );

    const deliveredParcels = await parcelsCollections
      .find({
        "deliveryRider.email": email,
        deliveryStatus: "delivered",
        deliveredAt: { $gte: startOfToday, $lte: endOfToday },
      })
      .sort({ deliveredAt: -1 })
      .toArray();

    const totalCollectedAmount = deliveredParcels.reduce(
      (t, p) => t + (Number(p.codAmount) || 0),
      0,
    );
    const totalAssign = Number(riderData.totalAssign) || 0;
    const successfullyComplete = Number(riderData.successfullyComplete) || 0;
    const conversionRate =
      totalAssign > 0
        ? Math.round((successfullyComplete / totalAssign) * 100)
        : 0;
    const loadHandled =
      todayDeliveryCompleteParcels.reduce(
        (t, p) => t + (Number(p.parcelWeight) || 0),
        0,
      ) +
      todayPickUpCompleteParcels.reduce(
        (t, p) => t + (Number(p.parcelWeight) || 0),
        0,
      );

    const payload = {
      success: true,
      riderData,
      allHandledParcels,
      assignedParcels,
      holdUpParcels,
      deliveredParcels,
      totalCollectedAmount,
      conversionRate,
      loadHandled,
      todaysParcels,
      allDeliveryCompleteParcels,
      allPickUpCompleteParcels,
      todaysParcelCount: todaysParcels.length || 0,
      todayPickUpCompleteParcels,
      todayDeliveryCompleteParcels,
      todaysCompleteTotal:
        todayPickUpCompleteParcels.length +
          todayDeliveryCompleteParcels.length || 0,
    };

    riderCache.set(cacheKey, payload);
    res.send(payload);
  } catch (error) {
    console.error("Rider API Error:", error);
    res.status(500).send({ success: false, message: "Internal Server Error" });
  }
});

app.patch("/rider/status/:email", async (req, res) => {
  try {
    const { ridersCollections } = await connectDB();
    const { workStatus } = req.body;
    const { email } = req.params;

    const rider = await ridersCollections.findOne({ email });
    const result = await ridersCollections.updateOne(
      { email },
      { $set: { workStatus } },
    );

    if (result.modifiedCount > 0 || result.matchedCount > 0) {
      riderCache.del(`rider_${email}`);
      const area = rider?.area || "global";
      ridersCache.bump(area);
      if (rider?.area)
        availableRidersCache.del(
          `available_riders_${rider.area.toLowerCase()}`,
        );

      return res.send({
        success: true,
        message: "Rider status synchronized successfully!",
      });
    } else {
      return res
        .status(404)
        .send({ success: false, message: "Rider not found" });
    }
  } catch (error) {
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.patch(
  "/riders/hold-parcel/update",
  verifyFireBaseToken,
  verifyRiderToken,
  async (req, res) => {
    try {
      const { ridersCollections, parcelsCollections } = await connectDB();
      const { riderId, parcelId } = req.body;

      await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        { $set: { "activeTasks.$[elem].isHold": true } },
        { arrayFilters: [{ "elem.parcelId": new ObjectId(parcelId) }] },
      );
      await parcelsCollections.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { deliveryStatus: "hold" } },
      );

      const parcelData = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });
      await logTracking(parcelData, "hold-up");

      invalidateParcelStatusChange({
        trackingID: parcelData.trackingID,
        senderEmail: parcelData.senderInfo?.email,
        originHub: parcelData.serviceCenters?.origin,
        destinationHub: parcelData.serviceCenters?.destination,
        parcelId,
      });
      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });
      if (rider) {
        riderCache.del(`rider_${rider.email}`);
        ridersCache.bump(rider.area || "global");
      }

      res
        .status(200)
        .send({ success: true, message: "Parcel marked as hold everywhere!" });
    } catch (error) {
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

app.post("/riders", async (req, res) => {
  try {
    const { ridersCollections, userCollections } = await connectDB();
    const newRider = req.body;
    const isExist = await ridersCollections.findOne({ email: newRider.email });
    if (isExist)
      return res.send({ message: "This email already used for rider!" });

    const result = await ridersCollections.insertOne(newRider);
    await userCollections.updateOne(
      { email: newRider.email },
      { $set: { role: "pending-rider" } },
    );

    userCache.del(`user_${newRider.email}`);
    userRoleCache.del(`user_role_${newRider.email}`);
    usersCache.bump("global");
    ridersCache.bump(newRider.area || "global");
    if (newRider.area)
      availableRidersCache.del(
        `available_riders_${newRider.area.toLowerCase()}`,
      );

    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get(
  "/riders",
  verifyFireBaseToken,
  verifyRoles("admin", "hub-manager", "rider"),
  async (req, res) => {
    try {
      const { status, workStatus, email, area } = req.query;
      const owner = area || "global";
      const cachedData = ridersCache.get(owner, [
        status || "all",
        workStatus || "all",
        email || "all",
      ]);
      if (cachedData) return res.status(200).send(cachedData);

      const { ridersCollections } = await connectDB();
      let query = {};
      if (status) query.status = status;
      if (workStatus) query.workStatus = workStatus;
      if (email) query.email = email;
      if (area) query.area = area;

      const result = await ridersCollections.find(query).toArray();
      ridersCache.set(
        owner,
        [status || "all", workStatus || "all", email || "all"],
        result,
      );
      res.status(200).send(result);
    } catch (error) {
      console.error("Error fetching riders:", error);
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

app.get(
  "/riders/available/:areaName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { areaName } = req.params;
      const cacheKey = `available_riders_${areaName.toLowerCase()}`;
      const cachedRiders = availableRidersCache.get(cacheKey);
      if (cachedRiders) return res.status(200).send(cachedRiders);

      const { ridersCollections } = await connectDB();
      const query = {
        area: areaName,
        workStatus: "available",
        currentTasks: { $lt: 10 },
      };
      const riders = await ridersCollections.find(query).toArray();
      availableRidersCache.set(cacheKey, riders);
      res.status(200).send(riders);
    } catch (error) {
      res
        .status(500)
        .send({ message: "Error fetching riders", error: error.message });
    }
  },
);

app.patch(
  "/riders/:id",
  verifyFireBaseToken,
  verifyAdminToken,
  async (req, res) => {
    try {
      const { ridersCollections, userCollections } = await connectDB();
      const id = req.params.id;
      const { status, workStatus, email } = req.body;

      const riderResult = await ridersCollections.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, workStatus, updatedAt: new Date() } },
      );

      if (riderResult.modifiedCount > 0) {
        const userResult = await userCollections.updateOne(
          { email },
          { $set: { role: "rider" } },
        );
        const rider = await ridersCollections.findOne({
          _id: new ObjectId(id),
        });

        userCache.del(`user_${email}`);
        userRoleCache.del(`user_role_${email}`);
        riderCache.del(`rider_${email}`);
        ridersCache.bump(rider?.area || "global");
        if (rider?.area)
          availableRidersCache.del(
            `available_riders_${rider.area.toLowerCase()}`,
          );
        usersCache.bump("global");

        res.send({
          success: true,
          message: "Rider approved and user role updated to rider",
          riderResult,
          userResult,
        });
      } else {
        res.status(404).send({ message: "Rider not found or no changes made" });
      }
    } catch (error) {
      console.error("Error approving rider:", error);
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

app.patch(
  "/parcels/assign-rider",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const {
        parcelId,
        riderId,
        riderName,
        riderEmail,
        riderPhone,
        trackingID,
      } = req.body;
      const { parcelsCollections, ridersCollections } = await connectDB();
      const parcelData = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });
      await logTracking(parcelData, "assign-pickup-rider");

      const parcelUpdate = await parcelsCollections.updateOne(
        { _id: new ObjectId(parcelId) },
        {
          $set: {
            deliveryStatus: "assign-pickup-rider",
            pickupRider: {
              id: riderId,
              name: riderName,
              email: riderEmail,
              phone: riderPhone,
              assignedAt: new Date(),
            },
          },
        },
      );

      const riderUpdate = await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        {
          $inc: { currentTasks: 1, totalAssign: 1 },
          $push: {
            activeTasks: {
              parcelId: new ObjectId(parcelId),
              trackingID,
              parcelName: parcelData.parcelName,
              codAmount: parcelData.codAmount,
              pickupLocation: parcelData.senderInfo.address,
              merchantName: parcelData.senderInfo.name,
              merchantPhone: parcelData.senderInfo.phone,
              taskType: "pickup",
              assignedAt: new Date(),
            },
          },
        },
      );

      if (parcelUpdate.modifiedCount > 0 && riderUpdate.modifiedCount > 0) {
        invalidateParcelStatusChange({
          trackingID: parcelData.trackingID,
          senderEmail: parcelData.senderInfo?.email,
          originHub: parcelData.serviceCenters?.origin,
          destinationHub: parcelData.serviceCenters?.destination,
          parcelId,
        });
        const rider = await ridersCollections.findOne({
          _id: new ObjectId(riderId),
        });
        riderCache.del(`rider_${riderEmail}`);
        ridersCache.bump(rider?.area || "global");
        if (rider?.area)
          availableRidersCache.del(
            `available_riders_${rider.area.toLowerCase()}`,
          );

        res
          .status(200)
          .send({ success: true, message: "Rider assigned successfully" });
      } else {
        res.status(400).send({ message: "Assignment failed" });
      }
    } catch (error) {
      res.status(500).send({ message: "Server error", error: error.message });
    }
  },
);

app.patch(
  "/parcels/assign-delivery",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const {
        parcelId,
        riderId,
        riderName,
        riderEmail,
        riderPhone,
        trackingID,
      } = req.body;
      const { parcelsCollections, ridersCollections } = await connectDB();
      const parcelData = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });

      const parcelUpdate = await parcelsCollections.updateOne(
        { _id: new ObjectId(parcelId) },
        {
          $set: {
            deliveryStatus: "assign-delivery-rider",
            deliveryRider: {
              id: riderId,
              name: riderName,
              email: riderEmail,
              phone: riderPhone,
              assignedAt: new Date(),
            },
          },
        },
      );
      await logTracking(parcelData, "assign-delivery-rider");

      const riderUpdate = await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        {
          $inc: { currentTasks: 1, totalAssign: 1 },
          $push: {
            activeTasks: {
              parcelId: new ObjectId(parcelId),
              trackingID,
              parcelName: parcelData.parcelName,
              codAmount: parcelData.codAmount,
              deliveryLocation: parcelData.receiverInfo.address,
              consumerName: parcelData.receiverInfo.name,
              consumerPhone: parcelData.receiverInfo.phone,
              taskType: "delivery",
              assignedAt: new Date(),
              isHold: false,
            },
          },
        },
      );

      if (parcelUpdate.modifiedCount > 0 && riderUpdate.modifiedCount > 0) {
        invalidateParcelStatusChange({
          trackingID: parcelData.trackingID,
          senderEmail: parcelData.senderInfo?.email,
          originHub: parcelData.serviceCenters?.origin,
          destinationHub: parcelData.serviceCenters?.destination,
          parcelId,
        });
        const rider = await ridersCollections.findOne({
          _id: new ObjectId(riderId),
        });
        riderCache.del(`rider_${riderEmail}`); // 💡 targeted
        ridersCache.bump(rider?.area || "global");
        if (rider?.area)
          availableRidersCache.del(
            `available_riders_${rider.area.toLowerCase()}`,
          );
        managerCache.bump("global");

        res
          .status(200)
          .send({ success: true, message: "Rider assigned successfully" });
      } else {
        res.status(400).send({ message: "Assignment failed" });
      }
    } catch (error) {
      res.status(500).send({ message: "Server error", error: error.message });
    }
  },
);

app.patch("/parcels/assign-return-delivery", async (req, res) => {
  try {
    const { parcelId, riderId, riderName, riderEmail, riderPhone, trackingID } =
      req.body;
    const { parcelsCollections, ridersCollections } = await connectDB();
    const parcelData = await parcelsCollections.findOne({
      _id: new ObjectId(parcelId),
    });

    const parcelUpdate = await parcelsCollections.updateOne(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          deliveryStatus: "assign-return-rider",
          returnRider: {
            id: riderId,
            name: riderName,
            email: riderEmail,
            phone: riderPhone,
            assignedAt: new Date(),
          },
        },
      },
    );
    await logTracking(parcelData, "assign-return-rider");

    const riderUpdate = await ridersCollections.updateOne(
      { _id: new ObjectId(riderId) },
      {
        $inc: { currentTasks: 1, totalAssign: 1 },
        $push: {
          activeTasks: {
            parcelId: new ObjectId(parcelId),
            trackingID,
            parcelName: parcelData.parcelName,
            codAmount: parcelData.codAmount,
            deliveryLocation: parcelData.receiverInfo.address,
            consumerName: parcelData.receiverInfo.name,
            consumerPhone: parcelData.receiverInfo.phone,
            taskType: "return-delivery",
            assignedAt: new Date(),
          },
        },
      },
    );

    if (parcelUpdate.modifiedCount > 0 && riderUpdate.modifiedCount > 0) {
      invalidateParcelStatusChange({
        trackingID: parcelData.trackingID,
        senderEmail: parcelData.senderInfo?.email,
        originHub: parcelData.serviceCenters?.origin,
        destinationHub: parcelData.serviceCenters?.destination,
        parcelId,
      });

      const originHub = parcelData.serviceCenters?.origin;
      if (originHub && typeof returnWarehouseCache !== "undefined") {
        const cacheKey = `return_warehouse_${originHub.toLowerCase()}`;
        returnWarehouseCache.del(cacheKey);
      }

      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });
      riderCache.del(`rider_${riderEmail}`);
      ridersCache.bump(rider?.area || "global");
      if (rider?.area)
        availableRidersCache.del(
          `available_riders_${rider.area.toLowerCase()}`,
        );

      res
        .status(200)
        .send({ success: true, message: "Rider assigned successfully" });
    } else {
      res.status(400).send({ message: "Assignment failed" });
    }
  } catch (error) {
    res.status(500).send({ message: "Server error", error: error.message });
  }
});

app.patch("/riders/complete-return-delivered/update", async (req, res) => {
  try {
    const { riderId, parcelId, trackingID } = req.body;
    if (!riderId || !parcelId) {
      return res
        .status(400)
        .send({ success: false, message: "Missing riderId or parcelId" });
    }
    const { parcelsCollections, ridersCollections } = await connectDB();

    const parcelUpdateResult = await parcelsCollections.updateOne(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          deliveryStatus: "returned-to-merchant",
          returnCompletedAt: new Date(),
          currentLocation: "merchant",
        },
      },
    );
    if (parcelUpdateResult.modifiedCount === 0) {
      return res
        .status(404)
        .send({
          success: false,
          message: "Parcel not found or already updated",
        });
    }

    const parcelData = await parcelsCollections.findOne({
      _id: new ObjectId(parcelId),
    });
    await logTracking(parcelData, "returned-to-merchant");
    await ridersCollections.updateOne(
      { _id: new ObjectId(riderId) },
      {
        $inc: { currentTasks: -1 },
        $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
      },
    );

    invalidateParcelStatusChange({
      trackingID: parcelData.trackingID,
      senderEmail: parcelData.senderInfo?.email,
      originHub: parcelData.serviceCenters?.origin,
      destinationHub: parcelData.serviceCenters?.destination,
      parcelId,
    });
    const rider = await ridersCollections.findOne({
      _id: new ObjectId(riderId),
    });
    if (rider) {
      riderCache.del(`rider_${rider.email}`);
      ridersCache.bump(rider.area || "global");
      if (rider.area)
        availableRidersCache.del(
          `available_riders_${rider.area.toLowerCase()}`,
        );
    }

    res.send({
      success: true,
      message:
        "Parcel successfully returned to merchant and rider task updated.",
    });
  } catch (error) {
    console.error("Error completing return delivery:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

app.patch(
  "/riders/complete-pickup/update",
  verifyFireBaseToken,
  verifyRiderToken,
  async (req, res) => {
    try {
      const { riderId, parcelId, trackingID } = req.body;
      const { parcelsCollections, ridersCollections } = await connectDB();

      await parcelsCollections.updateOne(
        { _id: new ObjectId(parcelId) },
        {
          $set: {
            deliveryStatus: "picked-up",
            currentLocation: "Picked & On Way",
          },
        },
      );
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });
      await logTracking(parcel, "rider-carrying");

      const result = await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        {
          $inc: { currentTasks: -1, successfullyComplete: 1 },
          $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
        },
      );

      invalidateParcelStatusChange({
        trackingID: parcel.trackingID,
        senderEmail: parcel.senderInfo?.email,
        originHub: parcel.serviceCenters?.origin,
        destinationHub: parcel.serviceCenters?.destination,
        parcelId,
      });
      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });
      if (rider) {
        riderCache.del(`rider_${rider.email}`);
        ridersCache.bump(rider.area || "global");
        if (rider.area)
          availableRidersCache.del(
            `available_riders_${rider.area.toLowerCase()}`,
          );
      }

      res.send({ success: true, result });
    } catch (error) {
      res
        .status(500)
        .send({ message: "Error completing pickup", error: error.message });
    }
  },
);

app.patch("/riders/return-req/update", async (req, res) => {
  try {
    const { riderId, parcelId } = req.body;
    const { parcelsCollections, ridersCollections, hubManagersCollection } =
      await connectDB();

    await parcelsCollections.updateOne(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          deliveryStatus: "return-requested",
          currentLocation: "way-back-destination-hub",
          returnReqAt: new Date(),
          isReturnRequested: true,
        },
      },
    );
    const parcel = await parcelsCollections.findOne({
      _id: new ObjectId(parcelId),
    });
    const hubName = parcel?.receiverInfo?.area;
    await logTracking(parcel, "return-requested");

    await ridersCollections.updateOne(
      { _id: new ObjectId(riderId) },
      {
        $inc: { currentTasks: -1 },
        $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
        $push: { returnLedger: { ...parcel, requestedAt: new Date() } },
      },
    );
    await hubManagersCollection.updateOne(
      { hubName: hubName },
      {
        $push: {
          returnReq: {
            ...parcel,
            requestedAt: new Date(),
            isHubReceived: false,
          },
        },
      },
    );

    invalidateParcelStatusChange({
      trackingID: parcel.trackingID,
      senderEmail: parcel.senderInfo?.email,
      originHub: parcel.serviceCenters?.origin,
      destinationHub: parcel.serviceCenters?.destination,
      parcelId,
    });
    const rider = await ridersCollections.findOne({
      _id: new ObjectId(riderId),
    });
    if (rider) {
      riderCache.del(`rider_${rider.email}`);
      ridersCache.bump(rider.area || "global");
      if (rider.area)
        availableRidersCache.del(
          `available_riders_${rider.area.toLowerCase()}`,
        );
    }
    managerCache.bump("global");

    res.send({
      success: true,
      message:
        "Return request processed. Parcel moved from Active Tasks to Return Ledger.",
    });
  } catch (error) {
    console.error("Return Request Error:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

app.patch("/parcels/return-hub/received/:parcelId", async (req, res) => {
  try {
    const { parcelId } = req.params;
    const { managerEmail } = req.body;
    const { hubManagersCollection, parcelsCollections, ridersCollections } =
      await connectDB();

    const managerUpdate = await hubManagersCollection.updateOne(
      {
        email: managerEmail,
        $or: [{ "returnReq._id": new ObjectId(parcelId) }],
      },
      { $set: { "returnReq.$.isHubReceived": true } },
    );
    managerCache.bump("global");

    if (managerUpdate.matchedCount === 0) {
      return res
        .status(404)
        .send({
          success: false,
          message: "Parcel not found in Hub Manager's return request ledger.",
        });
    }

    const parcel = await parcelsCollections.findOne({
      _id: new ObjectId(parcelId),
    });
    await logTracking(parcel, "returned-to-hub");

    await parcelsCollections.findOneAndUpdate(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          deliveryStatus: "returned-to-hub",
          currentLocation: "destination-hub",
          hubReceivedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );

    const riderEmail = parcel?.deliveryRider?.email;
    if (riderEmail) {
      await ridersCollections.updateOne(
        { email: riderEmail },
        { $pull: { returnLedger: { _id: new ObjectId(parcelId) } } },
      );
      riderCache.del(`rider_${riderEmail}`);
    }
    invalidateParcelStatusChange({
      trackingID: parcel.trackingID,
      senderEmail: parcel.senderInfo?.email,
      originHub: parcel.serviceCenters?.origin,
      destinationHub: parcel.serviceCenters?.destination,
      parcelId,
    });

    res.send({
      success: true,
      message:
        "Return successfully received at hub and cleared from rider task.",
    });
  } catch (error) {
    console.error("Return reception error:", error);
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.patch("/hub/dispatch-return-to-origin/:parcelId", async (req, res) => {
  try {
    const { parcelId } = req.params;
    const managerEmail = req.body.managerEmail;
    const { parcelsCollections, hubManagersCollection } = await connectDB();

    const updatedParcel = await parcelsCollections.findOneAndUpdate(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          deliveryStatus: "return-in-transit-to-origin",
          currentLocation: "on-the-way-to-origin-warehouse",
          dispatchedFromHubAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!updatedParcel) {
      return res
        .status(404)
        .send({
          success: false,
          message: "Parcel not found in warehouse registry.",
        });
    }
    await logTracking(updatedParcel, "dispatched-back-to-origin-warehouse");
    await hubManagersCollection.updateOne(
      { email: managerEmail },
      { $pull: { returnReq: { _id: new ObjectId(parcelId) } } },
    );

    managerCache.bump("global");
    invalidateParcelStatusChange({
      trackingID: updatedParcel.trackingID,
      senderEmail: updatedParcel.senderInfo?.email,
      originHub: updatedParcel.serviceCenters?.origin,
      destinationHub: updatedParcel.serviceCenters?.destination,
      parcelId,
    });

    res.send({
      success: true,
      message: "Parcel successfully dispatched to the origin warehouse!",
    });
  } catch (error) {
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

app.patch("/parcels/return-origin-hub/received/:parcelId", async (req, res) => {
  try {
    const { parcelsCollections } = await connectDB();
    const { parcelId } = req.params;
    const updatedParcel = await parcelsCollections.findOneAndUpdate(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          deliveryStatus: "receive-from-origin-warehouse",
          currentLocation: "receive-from-origin-warehouse",
          receiveFromOriHubAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );

    if (!updatedParcel) {
      return res
        .status(404)
        .send({ success: false, message: "Parcel not found in registry." });
    }

    managerCache.bump("global");
    invalidateParcelStatusChange({
      trackingID: updatedParcel.trackingID,
      senderEmail: updatedParcel.senderInfo?.email,
      originHub: updatedParcel.serviceCenters?.origin,
      destinationHub: updatedParcel.serviceCenters?.destination,
      parcelId,
    });
    if (updatedParcel.serviceCenters?.origin) {
      returnWarehouseCache.del(
        `return_warehouse_${updatedParcel.serviceCenters.origin.toLowerCase()}`,
      ); // 💡 targeted
    }

    await logTracking(updatedParcel, "receive-from-origin-warehouse");
    res.send({
      success: true,
      message: "Parcel successfully received from origin warehouse!",
    });
  } catch (error) {
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

app.get("/warehouse/return-house/:hubName", async (req, res) => {
  try {
    const { hubName } = req.params;
    const cacheKey = `return_warehouse_${hubName.toLowerCase()}`;
    const cachedParcels = returnWarehouseCache.get(cacheKey);
    if (cachedParcels)
      return res.send({ success: true, returnList: cachedParcels });

    const { parcelsCollections } = await connectDB();
    const parcels = await parcelsCollections
      .find({
        "serviceCenters.origin": hubName,
        deliveryStatus: "receive-from-origin-warehouse",
      })
      .toArray();

    returnWarehouseCache.set(cacheKey, parcels);
    res.send({ success: true, returnList: parcels });
  } catch (error) {
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

app.patch(
  "/riders/complete-delivered/update",
  verifyFireBaseToken,
  verifyRiderToken,
  async (req, res) => {
    try {
      const { riderId, parcelId, trackingID } = req.body;
      const { parcelsCollections, ridersCollections, merchantsCollections } =
        await connectDB();

      await parcelsCollections.updateOne(
        { _id: new ObjectId(parcelId) },
        {
          $set: {
            deliveryStatus: "delivered",
            currentLocation: "delivered",
            deliveredAt: new Date(),
          },
        },
      );
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });

      const merchantEmail = parcel.senderInfo.email;
      if (merchantEmail) {
        await merchantsCollections.updateOne(
          { email: merchantEmail },
          { $inc: { totalSuccessfulDeliveries: 1 } },
        );
      }

      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });
      const riderEmail = rider.email;
      await logTracking(parcel, "delivered");

      const result = await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        {
          $inc: { currentTasks: -1, successfullyComplete: 1 },
          $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
        },
      );

      invalidateParcelStatusChange({
        trackingID: parcel.trackingID,
        senderEmail: merchantEmail,
        originHub: parcel.serviceCenters?.origin,
        destinationHub: parcel.serviceCenters?.destination,
        parcelId,
      });
      ridersCache.bump(rider.area || "global");
      if (rider.area)
        availableRidersCache.del(
          `available_riders_${rider.area.toLowerCase()}`,
        );

      if (merchantEmail) targetedMerchantCache.del(`merchant_${merchantEmail}`);
      riderCache.del(`rider_${riderEmail}`);

      res.send({ success: true, result });
    } catch (error) {
      res
        .status(500)
        .send({ message: "Error completing pickup", error: error.message });
    }
  },
);

app.delete("/riders/:id", async (req, res) => {
  try {
    const { ridersCollections, usersCollection } = await connectDB();
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const riderData = await ridersCollections.findOne(query);

    if (!riderData) {
      return res
        .status(404)
        .send({ success: false, message: "Rider request not found" });
    }

    const deleteResult = await ridersCollections.deleteOne(query);
    if (deleteResult.deletedCount > 0) {
      const userUpdateResult = await usersCollection.updateOne(
        { email: riderData.email },
        { $set: { role: "user" } },
      );

      userCache.del(`user_${riderData.email}`);
      userRoleCache.del(`user_role_${riderData.email}`);
      riderCache.del(`rider_${riderData.email}`);
      ridersCache.bump(riderData.area || "global");
      if (riderData.area)
        availableRidersCache.del(
          `available_riders_${riderData.area.toLowerCase()}`,
        );

      res.send({
        success: true,
        message: "Rider request deleted and user role reset to user",
        deleteResult,
        userUpdateResult,
      });
    }
  } catch (error) {
    console.error("Error rejecting rider:", error);
    res.status(500).send({ success: false, message: "Internal Server Error" });
  }
});

/* ---- Merchant APIs Start ---- */
app.get(
  "/all-merchants",
  verifyFireBaseToken,
  verifyAdminToken,
  async (req, res) => {
    try {
      const cacheKey = "allMerchants";
      const cacheData = allMerchantsCache.get(cacheKey);
      if (cacheData) return res.send({ success: true, cacheData });

      const { merchantsCollections } = await connectDB();
      const result = await merchantsCollections.find({}).toArray();
      allMerchantsCache.set(cacheKey, result);
      res.send(result);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  },
);

app.get(
  "/area-merchant/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `area_merchant_${hubName}`;
      const cachedMerchants = merchantsAreaWiseCache.get(cacheKey);
      if (cachedMerchants) return res.send(cachedMerchants);

      const { merchantsCollections } = await connectDB();
      const result = await merchantsCollections
        .find({ area: hubName })
        .toArray();
      merchantsAreaWiseCache.set(cacheKey, result);
      res.send(result);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  },
);

app.post("/merchants", async (req, res) => {
  try {
    const { merchantsCollections, userCollections } = await connectDB();
    const newMerchant = req.body;
    const isExist = await merchantsCollections.findOne({
      email: newMerchant.email,
    });
    if (isExist)
      return res.send({ message: "This email already used for Merchant!" });

    const result = await merchantsCollections.insertOne(newMerchant);
    await userCollections.updateOne(
      { email: newMerchant.email },
      { $set: { role: "merchant" } },
    );

    userCache.del(`user_${newMerchant.email}`);
    userRoleCache.del(`user_role_${newMerchant.email}`);
    usersCache.bump("global");
    allMerchantsCache.del("allMerchants");
    if (newMerchant.area)
      merchantsAreaWiseCache.del(`area_merchant_${newMerchant.area}`);

    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.get(
  "/merchant/:email",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const email = req.params.email;
      const cacheKey = `merchant_${email}`;
      const cachedData = targetedMerchantCache.get(cacheKey);
      if (cachedData) return res.send(cachedData);

      const { merchantsCollections } = await connectDB();
      const merchant = await merchantsCollections.findOne({ email: email });
      if (!merchant) {
        return res
          .status(404)
          .send({ success: false, message: "User not found in database" });
      }

      const responseData = {
        success: true,
        role: merchant.role,
        email: merchant.email,
        ...merchant,
      };
      targetedMerchantCache.set(cacheKey, responseData);
      res.send(responseData);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  },
);

app.patch(
  "/merchant-update/:email",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { merchantsCollections } = await connectDB();
      const email = req.params.email;
      const updatedMerchantInfo = req.body;
      const result = await merchantsCollections.updateOne(
        { email },
        { $set: updatedMerchantInfo },
      );

      if (result.modifiedCount > 0) {
        targetedMerchantCache.del(`merchant_${email}`);
        userCache.del(`user_${email}`);
        allMerchantsCache.del("allMerchants");
        if (updatedMerchantInfo.area)
          merchantsAreaWiseCache.del(
            `area_merchant_${updatedMerchantInfo.area}`,
          );

        res.send({ success: true, message: "Merchant profile edited done" });
      } else {
        res.status(404).send({ success: false, message: "Merchant not found" });
      }
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  },
);

/* ---- Payment Payout ---- */
app.get("/payment-payout-summary/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const cacheKey = `payout_summary_${email.toLowerCase()}`;
    const cachedData = payoutSummaryCache.get(cacheKey);
    if (cachedData) return res.send(cachedData);

    const { parcelsCollections, payoutsCollections } = await connectDB();
    const deliveredParcels = await parcelsCollections
      .find({
        "senderInfo.email": email,
        deliveryStatus: "delivered",
        merchantRevenueStatus: false,
      })
      .toArray();

    let availableBalance = 0;
    deliveredParcels.forEach((parcel) => {
      const cod = parcel.codAmount;
      const deliveryCharge = parcel.deliveryCharge;
      parcel.deliveryChargeStatus === "paid"
        ? (availableBalance += cod)
        : (availableBalance += cod - deliveryCharge);
    });

    const completedPayouts = await payoutsCollections
      .find({ email: email, payoutStatus: "completed" })
      .toArray();
    const totalWithdrawn = completedPayouts.reduce(
      (sum, p) => sum + p.amount,
      0,
    );

    const pendingPayouts = await payoutsCollections
      .find({ email: email, payoutStatus: "pending" })
      .toArray();
    const totalPending = pendingPayouts.reduce(
      (sum, p) => sum + (Number(p.amount) || 0),
      0,
    );

    const recentTransactions = await payoutsCollections
      .find({ email: email })
      .limit(5)
      .sort({ requestedAt: -1 })
      .toArray();
    const pendingTransactions = await payoutsCollections
      .find({ email: email, payoutStatus: "pending" })
      .sort({ requestedAt: -1 })
      .toArray();

    const responseData = {
      success: true,
      totalRevenue: availableBalance,
      totalWithdrawn,
      totalPending,
      availableBalance,
      deliveredParcels,
      recentTransactions,
      pendingTransactions,
      completedPayouts,
    };
    payoutSummaryCache.set(cacheKey, responseData);
    res.send(responseData);
  } catch (error) {
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.post("/request-payout", async (req, res) => {
  try {
    const { parcelsCollections, paymentCollections, payoutsCollections } =
      await connectDB();
    const { email, withdrawAmount, paymentMethod } = req.body;
    if (!email || !withdrawAmount || withdrawAmount <= 0) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid request data" });
    }

    const deliveredParcels = await parcelsCollections
      .find({
        "senderInfo.email": email,
        deliveryStatus: "delivered",
        merchantRevenueStatus: false,
      })
      .toArray();

    let totalRevenue = 0;
    deliveredParcels.forEach((parcel) => {
      const cod = parcel.codAmount;
      const deliveryCharge = parcel.deliveryCharge;
      parcel.deliveryChargeStatus === "paid"
        ? (totalRevenue += cod)
        : (totalRevenue += cod - deliveryCharge);
    });

    if (withdrawAmount > totalRevenue) {
      return res
        .status(400)
        .send({
          success: false,
          message:
            "Insufficient balance! You cannot withdraw more than your available balance.",
        });
    }

    const baseParcelsInfo = deliveredParcels.map((parcel) => ({
      parcelId: parcel._id,
      codAmount: parcel.codAmount,
      deliveryCharge: parcel.deliveryCharge,
      merchantName: parcel.senderInfo?.name || "N/A",
    }));

    const newPayoutRequest = {
      email,
      amount: Number(withdrawAmount),
      payoutStatus: "pending",
      method: paymentMethod?.type || "bKash",
      accountNumber: paymentMethod?.number || "N/A",
      requestedAt: new Date().toISOString(),
      trxID: null,
      parcelsBreakdown: baseParcelsInfo,
    };
    const result = await payoutsCollections.insertOne(newPayoutRequest);

    if (result.insertedId) {
      const parcelIds = baseParcelsInfo.map((p) => p.parcelId);
      await parcelsCollections.updateMany(
        { _id: { $in: parcelIds } },
        { $set: { merchantRevenueStatus: "pending" } },
      );

      payoutSummaryCache.del(`payout_summary_${email.toLowerCase()}`);
      allPayoutsCache.del("all_pending_payouts");
      merchantUnpaidCache.del(`unpaid_parcels_${email}`);
      merchantParcelsCache.bump(email);
      parcelsStatusWiseCache.bump(email);
      revenueStatsCache.bump(email);

      res.send({
        success: true,
        message:
          "Payout request submitted successfully. Waiting for admin approval.",
        insertedId: result.insertedId,
      });
    } else {
      res
        .status(500)
        .send({ success: false, message: "Failed to create payout request" });
    }
  } catch (error) {
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.patch("/approve-payout/:id", async (req, res) => {
  try {
    const { payoutsCollections, parcelsCollections } = await connectDB();
    const payoutId = req.params.id;
    const { status, trxID } = req.body;

    const payoutRequest = await payoutsCollections.findOne({
      _id: new ObjectId(payoutId),
    });
    if (!payoutRequest) {
      return res
        .status(404)
        .send({ success: false, message: "Payout request not found" });
    }

    if (status === "Completed") {
      if (!trxID) {
        return res
          .status(400)
          .send({
            success: false,
            message:
              "Transaction ID (TrxID) is required for completed payouts.",
          });
      }
      await payoutsCollections.updateOne(
        { _id: new ObjectId(payoutId) },
        {
          $set: {
            payoutStatus: "completed",
            trxID,
            approvedAt: new Date().toISOString(),
          },
        },
      );
      const parcelIds = payoutRequest.parcelsBreakdown.map(
        (p) => new ObjectId(p.parcelId),
      );
      await parcelsCollections.updateMany(
        { _id: { $in: parcelIds } },
        { $set: { merchantRevenueStatus: true, deliveryChargeStatus: "paid" } },
      );

      allPayoutsCache.del("all_pending_payouts");
      payoutSummaryCache.del(
        `payout_summary_${payoutRequest.email.toLowerCase()}`,
      );
      merchantParcelsCache.bump(payoutRequest.email);
      parcelsStatusWiseCache.bump(payoutRequest.email);
      allMerchantsCache.del("allMerchants");
      merchantUnpaidCache.del(`unpaid_parcels_${payoutRequest.email}`);

      return res.send({
        success: true,
        message: "Payout approved and completed successfully!",
      });
    }

    if (status === "Rejected") {
      await payoutsCollections.updateOne(
        { _id: new ObjectId(payoutId) },
        {
          $set: {
            payoutStatus: "rejected",
            rejectedAt: new Date().toISOString(),
          },
        },
      );
      const parcelIds = payoutRequest.parcelsBreakdown.map(
        (p) => new ObjectId(p.parcelId),
      );
      await parcelsCollections.updateMany(
        { _id: { $in: parcelIds } },
        { $set: { merchantRevenueStatus: null } },
      );

      allPayoutsCache.del("all_pending_payouts");
      payoutSummaryCache.del(
        `payout_summary_${payoutRequest.email.toLowerCase()}`,
      );
      merchantParcelsCache.bump(payoutRequest.email);
      parcelsStatusWiseCache.bump(payoutRequest.email);
      allMerchantsCache.del("allMerchants");
      merchantUnpaidCache.del(`unpaid_parcels_${payoutRequest.email}`);

      return res.send({
        success: true,
        message:
          "Payout request rejected. Parcels released back to merchant balance.",
      });
    }
  } catch (error) {
    console.error("Approval API Error:", error);
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.get("/all-payouts", async (req, res) => {
  try {
    const cacheKey = "all_pending_payouts";
    const cachedData = allPayoutsCache.get(cacheKey);
    if (cachedData) return res.send(cachedData);

    const { payoutsCollections } = await connectDB();
    const result = await payoutsCollections
      .find({ payoutStatus: "pending" })
      .sort({ requestedAt: -1 })
      .toArray();
    const responseData = { success: true, data: result };
    allPayoutsCache.set(cacheKey, responseData);
    res.send({ success: true, data: responseData });
  } catch (error) {
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

/*---- Parcels Related APIs ----*/
app.get(
  "/parcels",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { email, filter, search, status } = req.query;
      const { parcelsCollections } = await connectDB();
      const skip = parseInt(req.query.skip) || 0;
      const limit = parseInt(req.query.limit) || 10;

      const params = [filter || "all", status || "all", skip, limit];
      const cachedData = merchantParcelsCache.get(email.toLowerCase(), params);
      if (cachedData) return res.send(cachedData);

      let startDate = new Date();
      if (filter === "this-week") startDate.setDate(startDate.getDate() - 7);
      else if (filter === "last-week")
        startDate.setDate(startDate.getDate() - 14);
      else if (filter === "last-month")
        startDate.setMonth(startDate.getMonth() - 1);
      else startDate = null;

      const query = { "senderInfo.email": email };
      if (startDate) query.createdAt = { $gte: startDate.toISOString() };
      if (req.query.status) query.deliveryStatus = req.query.status;

      const [result, count] = await Promise.all([
        parcelsCollections
          .find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        parcelsCollections.countDocuments(query),
      ]);

      const responseData = { count, data: result };
      merchantParcelsCache.set(email.toLowerCase(), params, responseData);
      res.send(responseData);
    } catch (error) {
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

app.get("/parcel/:parcelID", async (req, res) => {
  try {
    const cacheKey = `parcel_${req.params.parcelID}`;
    const cachedParcel = parcelDetailCache.get(cacheKey);
    if (cachedParcel) return res.send(cachedParcel);

    const { parcelsCollections } = await connectDB();
    const parcel = await parcelsCollections.findOne({
      _id: new ObjectId(req.params.parcelID),
    });
    parcelDetailCache.set(cacheKey, parcel);
    res.send(parcel);
  } catch (error) {
    res.status(500).send({ success: false, error: "Internal Server Error" });
  }
});

app.get(
  "/late-invoices/:email",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const cacheKey = `late_invoices_${req.params.email}`;
      const cachedData = lateInvoicesCache.get(cacheKey);
      if (cachedData) return res.send(cachedData);

      const { parcelsCollections } = await connectDB();
      const lateInvoices = await parcelsCollections
        .find({
          "senderInfo.email": req.params.email,
          deliveryChargeStatus: "unpaid",
          deliveryStatus: "delivered",
        })
        .toArray();

      lateInvoicesCache.set(cacheKey, lateInvoices);
      res.send(lateInvoices);
    } catch (error) {
      res.status(500).send({ message: "Failed to fetch late invoices" });
    }
  },
);

app.get("/parcels/unpaid/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const cacheKey = `unpaid_parcels_${email}`;
    const cachedData = merchantUnpaidCache.get(cacheKey);
    if (cachedData) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(cachedData);
    }

    const { parcelsCollections } = await connectDB();
    const unpaidParcels = await parcelsCollections
      .find({ "senderInfo.email": email, deliveryChargeStatus: "unpaid" })
      .sort({ createdAt: -1 })
      .toArray();

    const totalDue = unpaidParcels.reduce(
      (sum, parcel) => sum + (parcel.deliveryCharge || 0),
      0,
    );
    const responsePayload = {
      success: true,
      totalDue,
      count: unpaidParcels.length,
      data: unpaidParcels,
    };
    const jsonString = JSON.stringify(responsePayload);
    merchantUnpaidCache.set(cacheKey, jsonString);

    res.setHeader("Content-Type", "application/json");
    res.send(jsonString);
  } catch (error) {
    console.error("Error fetching unpaid parcels:", error);
    res.status(500).send({ success: false, message: "Internal Server Error" });
  }
});

app.get("/parcels/status/:email", async (req, res) => {
  try {
    const email = req.params.email;
    const status = req.query.status;
    const cachedString = parcelsStatusWiseCache.get(email, [status || "all"]);
    if (cachedString) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(cachedString);
    }

    const { parcelsCollections } = await connectDB();
    let query = { "senderInfo.email": email };
    if (status) query.deliveryStatus = status;

    const result = await parcelsCollections.find(query).toArray();
    const jsonString = JSON.stringify(result);
    parcelsStatusWiseCache.set(email, [status || "all"], jsonString);

    res.setHeader("Content-Type", "application/json");
    res.status(200).send(jsonString);
  } catch (error) {
    console.error("Error loading filtered parcels:", error);
    res.status(500).send({ message: "Internal Server Error" });
  }
});

app.get(
  "/parcels/stats/:email",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const email = req.params.email;
      const cacheKey = `parcel_stats_${email}`;
      const cachedString = parcelStatsCache.get(cacheKey);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      const { parcelsCollections } = await connectDB();
      const stats = await parcelsCollections
        .aggregate([
          { $match: { "senderInfo.email": req.params.email } },
          {
            $group: {
              _id: {
                deliveryStatus: "$deliveryStatus",
                deliveryChargeStatus: "$deliveryChargeStatus",
              },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray();

      const formattedData = {
        toPay: 0,
        readyPickUp: 0,
        inTransit: 0,
        readyDeliver: 0,
        delivered: 0,
      };
      stats.forEach((element) => {
        if (element._id.deliveryChargeStatus === "unpaid")
          formattedData.toPay += element.count;
        if (element._id.deliveryStatus === "assign-pickup-rider")
          formattedData.readyPickUp += element.count;
        if (element._id.deliveryStatus === "in-transit")
          formattedData.inTransit += element.count;
        if (element._id.deliveryStatus === "assign-delivery-rider")
          formattedData.readyDeliver += element.count;
        if (element._id.deliveryStatus === "delivered")
          formattedData.delivered += element.count;
      });

      const jsonString = JSON.stringify(formattedData);
      parcelStatsCache.set(cacheKey, jsonString);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

const pendingRequests = new Map();
app.get(
  "/revenue/stats/:email",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const email = req.params.email;
      const { filter } = req.query;
      const cachedString = revenueStatsCache.get(email, [filter || "default"]);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      const dedupeKey = `${email}:${filter}`;
      if (!pendingRequests.has(dedupeKey)) {
        const fetchPromise = (async () => {
          const { parcelsCollections } = await connectDB();
          let startDate = new Date();
          if (filter === "this-week")
            startDate.setDate(startDate.getDate() - 7);
          else if (filter === "last-week")
            startDate.setDate(startDate.getDate() - 14);
          else if (filter === "last-month")
            startDate.setMonth(startDate.getMonth() - 1);
          else startDate.setDate(startDate.getDate() - 7);

          const stats = await parcelsCollections
            .aggregate([
              {
                $match: {
                  "senderInfo.email": req.params.email,
                  deliveryStatus: "delivered",
                  createdAt: { $gte: startDate.toISOString() },
                },
              },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%d %b",
                      date: { $toDate: "$createdAt" },
                    },
                  },
                  totalRevenue: { $sum: "$codAmount" },
                },
              },
              { $sort: { _id: 1 } },
            ])
            .toArray();

          const chartData = stats.map((element) => ({
            name: element._id,
            value: element.totalRevenue,
          }));
          const jsonString = JSON.stringify(chartData);
          revenueStatsCache.set(email, [filter || "default"], jsonString);
          return jsonString;
        })();
        pendingRequests.set(dedupeKey, fetchPromise);
      }

      const jsonString = await pendingRequests.get(dedupeKey);
      pendingRequests.delete(dedupeKey);

      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      const email = req.params.email;
      const { filter } = req.query;
      pendingRequests.delete(`${email}:${filter}`);
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

app.get("/tracking/:id", async (req, res) => {
  try {
    const cachedData = trackingCache.get(req.params.id);
    if (cachedData) {
      return res
        .status(200)
        .send({ success: true, source: "cache", result: cachedData });
    }

    const { trackingLogsCollections } = await connectDB();
    const result = await trackingLogsCollections
      .find({ trackingID: req.params.id })
      .sort({ createdAt: -1 })
      .toArray();
    trackingCache.set(req.params.id, result);
    res.status(200).send({ success: true, result });
  } catch (error) {
    res.status(500).send({ message: "Error loading tracking logs" });
  }
});

app.post(
  "/parcels",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { parcelsCollections } = await connectDB();
      const newParcel = req.body;
      await logTracking(newParcel, "parcel-created");
      const result = await parcelsCollections.insertOne(newParcel);

      const senderEmail = newParcel.senderInfo?.email;
      if (senderEmail) {
        merchantParcelsCache.bump(senderEmail);
        parcelsStatusWiseCache.bump(senderEmail);
        merchantUnpaidCache.del(`unpaid_parcels_${senderEmail}`);
      }
      const originHub = newParcel.serviceCenters?.origin;
      if (originHub) {
        hubEfficiencyCache.del(`hub_efficiency_flow_${originHub}`);
        hubAgingCache.del(`hub_aging_status_${originHub}`);
        incomingParcelsCache.del(`incoming_parcels_${originHub}`);
      }

      res.send(result);
    } catch (error) {
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

app.delete(
  "/parcel/:id",
  verifyFireBaseToken,
  verifyMerchantToken,
  verifyOwner,
  async (req, res) => {
    try {
      const { parcelsCollections } = await connectDB();
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(req.params.id),
      }); // 💡 fetched before delete so we still know its owner/hub for invalidation
      const result = await parcelsCollections.deleteOne({
        _id: new ObjectId(req.params.id),
      });

      if (parcel) {
        invalidateParcelStatusChange({
          trackingID: parcel.trackingID,
          senderEmail: parcel.senderInfo?.email,
          originHub: parcel.serviceCenters?.origin,
          destinationHub: parcel.serviceCenters?.destination,
          parcelId: req.params.id,
        });
      }
      res.send(result);
    } catch (error) {
      res.status(500).send({ message: "Internal Server Error" });
    }
  },
);

app.patch(
  "/parcels/dispatch/:id",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { parcelsCollections } = await connectDB();
      const result = await parcelsCollections.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            deliveryStatus: "in-transit",
            currentLocation: "Transport",
            updatedAt: new Date(),
          },
        },
      );
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(id),
      });
      await logTracking(parcel, "in-transit");

      if (result.modifiedCount > 0) {
        invalidateParcelStatusChange({
          trackingID: parcel.trackingID,
          senderEmail: parcel.senderInfo?.email,
          originHub: parcel.serviceCenters?.origin,
          destinationHub: parcel.serviceCenters?.destination,
          parcelId: id,
        });
        managerCache.bump("global");
        res.send({
          success: true,
          message: "Parcel status updated to in-transit",
        });
      } else {
        res.status(404).send({ success: false, message: "Parcel not found" });
      }
    } catch (error) {
      res.status(500).send({ message: "Server Error", error: error.message });
    }
  },
);

app.patch(
  "/parcels/dest-hub/received/:id",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { parcelsCollections } = await connectDB();
      const result = await parcelsCollections.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            deliveryStatus: "reached-destination-warehouse",
            currentLocation: "destination-warehouse",
            updatedAt: new Date(),
          },
        },
      );
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(id),
      });
      await logTracking(parcel, "reached-destination-warehouse");

      if (result.modifiedCount > 0) {
        invalidateParcelStatusChange({
          trackingID: parcel.trackingID,
          senderEmail: parcel.senderInfo?.email,
          originHub: parcel.serviceCenters?.origin,
          destinationHub: parcel.serviceCenters?.destination,
          parcelId: id,
        });
        managerCache.bump("global");
        res.send({
          success: true,
          message: "Parcel status updated to in-transit",
        });
      } else {
        res.status(404).send({ success: false, message: "Parcel not found" });
      }
    } catch (error) {
      res.status(500).send({ message: "Server Error", error: error.message });
    }
  },
);

app.patch(
  "/parcels/origin-hub/received/:id",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { parcelsCollections } = await connectDB();
      const result = await parcelsCollections.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            deliveryStatus: "reached-origin-warehouse",
            currentLocation: "origin-warehouse",
            updatedAt: new Date(),
          },
        },
      );
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(id),
      });
      await logTracking(parcel, "reached-origin-warehouse");

      if (result.modifiedCount > 0) {
        invalidateParcelStatusChange({
          trackingID: parcel.trackingID,
          senderEmail: parcel.senderInfo?.email,
          originHub: parcel.serviceCenters?.origin,
          destinationHub: parcel.serviceCenters?.destination,
          parcelId: id,
        });
        managerCache.bump("global");
        res.send({
          success: true,
          message: "Parcel status updated to in-transit",
        });
      } else {
        res.status(404).send({ success: false, message: "Parcel not found" });
      }
    } catch (error) {
      res.status(500).send({ message: "Server Error", error: error.message });
    }
  },
);

const pendingHubRequests = new Map();
app.get("/hub-hand-cash/:hubName", async (req, res) => {
  try {
    const { hubName } = req.params;
    const cacheKey = `hub_hand_cash_${hubName}`;
    const cachedString = hubHandCashCache.get(cacheKey);
    if (cachedString) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(cachedString);
    }

    if (!pendingHubRequests.has(cacheKey)) {
      const fetchPromise = (async () => {
        const { parcelsCollections } = await connectDB();
        const parcels = await parcelsCollections
          .find({
            "serviceCenters.destination": hubName,
            deliveryStatus: "delivered",
            isDepositedToHQ: false,
          })
          .toArray();

        let totalHandCash = 0;
        parcels.forEach((parcel) => {
          const isPayoutPending = [false, "pending"].includes(
            parcel.merchantRevenueStatus,
          );
          if (isPayoutPending) totalHandCash += parcel.codAmount || 0;
          else if (!parcel.deliveryChargeOnlinePaymentStatus)
            totalHandCash += parcel.deliveryCharge || 0;
        });

        const responseData = {
          success: true,
          parcels,
          hubName,
          totalParcelCount: parcels.length,
          totalHandCash,
        };
        const jsonString = JSON.stringify(responseData);
        hubHandCashCache.set(cacheKey, jsonString);
        return jsonString;
      })();
      pendingHubRequests.set(cacheKey, fetchPromise);
    }

    const jsonString = await pendingHubRequests.get(cacheKey);
    pendingHubRequests.delete(cacheKey);
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(jsonString);
  } catch (error) {
    const { hubName } = req.params;
    pendingHubRequests.delete(`hub_hand_cash_${hubName}`);
    res
      .status(500)
      .send({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
  }
});

const pendingHubProfitRequests = new Map();
app.get(
  "/hub-profit-metrics/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `hub_profit_metrics_${hubName}`;
      const cachedString = hubProfitCache.get(cacheKey);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      if (!pendingHubProfitRequests.has(cacheKey)) {
        const fetchPromise = (async () => {
          const { parcelsCollections } = await connectDB();
          const parcels = await parcelsCollections
            .find({
              "serviceCenters.destination": hubName,
              deliveryStatus: "delivered",
              isDepositedToHQ: false,
            })
            .toArray();

          let hqPayableProfit = 0,
            payableParcelCount = 0;
          parcels.forEach((parcel) => {
            if (!parcel.deliveryChargeOnlinePaymentStatus) {
              hqPayableProfit += parcel.deliveryCharge || 0;
              payableParcelCount += 1;
            }
          });

          const responseData = {
            success: true,
            hubName,
            totalParcelCount: payableParcelCount,
            hqPayableProfit,
          };
          const jsonString = JSON.stringify(responseData);
          hubProfitCache.set(cacheKey, jsonString);
          return jsonString;
        })();
        pendingHubProfitRequests.set(cacheKey, fetchPromise);
      }

      const jsonString = await pendingHubProfitRequests.get(cacheKey);
      pendingHubProfitRequests.delete(cacheKey);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      const { hubName } = req.params;
      pendingHubProfitRequests.delete(`hub_profit_metrics_${hubName}`);
      console.error("Hub Profit Metrics Error:", error);
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

const pendingHubAgingRequests = new Map();
app.get(
  "/hub-aging-status/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `hub_aging_status_${hubName}`;
      const cachedString = hubAgingCache.get(cacheKey);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      if (!pendingHubAgingRequests.has(cacheKey)) {
        const fetchPromise = (async () => {
          const { parcelsCollections } = await connectDB();
          const activeParcels = await parcelsCollections
            .find({
              $or: [
                { "serviceCenters.origin": hubName },
                { "serviceCenters.destination": hubName },
              ],
              deliveryStatus: {
                $in: [
                  "reached-origin-warehouse",
                  "reached-destination-warehouse",
                ],
              },
            })
            .toArray();

          let age24H = 0,
            age48H = 0,
            age72HPlus = 0;
          const now = new Date();
          activeParcels.forEach((parcel) => {
            if (parcel.createdAt) {
              const diffInHours =
                (now - new Date(parcel.createdAt)) / (1000 * 60 * 60);
              if (diffInHours <= 24) age24H++;
              else if (diffInHours <= 48) age48H++;
              else age72HPlus++;
            }
          });

          const jsonString = JSON.stringify({ age24H, age48H, age72HPlus });
          hubAgingCache.set(cacheKey, jsonString);
          return jsonString;
        })();
        pendingHubAgingRequests.set(cacheKey, fetchPromise);
      }

      const jsonString = await pendingHubAgingRequests.get(cacheKey);
      pendingHubAgingRequests.delete(cacheKey);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      const { hubName } = req.params;
      pendingHubAgingRequests.delete(`hub_aging_status_${hubName}`);
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

const pendingHubEfficiencyRequests = new Map();
app.get(
  "/hub-efficiency-flow/:hubName",
  verifyFireBaseToken,
  verifyHubManagerToken,
  async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `hub_efficiency_flow_${hubName}`;
      const cachedString = hubEfficiencyCache.get(cacheKey);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      if (!pendingHubEfficiencyRequests.has(cacheKey)) {
        const fetchPromise = (async () => {
          const { parcelsCollections } = await connectDB();
          const now = new Date();
          const sevenDayAgoStr = new Date(
            now.getTime() - 7 * 24 * 60 * 60 * 1000,
          ).toISOString();

          const sortingCount = await parcelsCollections.countDocuments({
            createdAt: { $gte: sevenDayAgoStr },
            $or: [
              {
                "serviceCenters.origin": hubName,
                deliveryStatus: "reached-origin-warehouse",
              },
              {
                "serviceCenters.destination": hubName,
                deliveryStatus: "reached-destination-warehouse",
              },
            ],
          });
          const OutForDeliveryCount = await parcelsCollections.countDocuments({
            "serviceCenters.destination": hubName,
            createdAt: { $gte: sevenDayAgoStr },
            deliveryStatus: "assign-delivery-rider",
          });
          const deliveredCount = await parcelsCollections.countDocuments({
            "serviceCenters.destination": hubName,
            createdAt: { $gte: sevenDayAgoStr },
            deliveryStatus: "delivered",
          });

          const total = sortingCount + OutForDeliveryCount + deliveredCount;
          const responseData = {
            sorting: Math.round((sortingCount / total) * 100) || 0,
            outDelivery: Math.round((OutForDeliveryCount / total) * 100) || 0,
            delivered: Math.round((deliveredCount / total) * 100) || 0,
            totalActive: total,
          };
          const jsonString = JSON.stringify(responseData);
          hubEfficiencyCache.set(cacheKey, jsonString);
          return jsonString;
        })();
        pendingHubEfficiencyRequests.set(cacheKey, fetchPromise);
      }

      const jsonString = await pendingHubEfficiencyRequests.get(cacheKey);
      pendingHubEfficiencyRequests.delete(cacheKey);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      const { hubName } = req.params;
      pendingHubEfficiencyRequests.delete(`hub_efficiency_flow_${hubName}`);
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

app.post("/deposit-HQ/:hubName", async (req, res) => {
  try {
    const { hubName } = req.params;
    const { hqPaymentsCollections, parcelsCollections } = await connectDB();
    const {
      depositedAmount,
      parcelIds,
      paymentMethod,
      transactionDetails,
      submittedBy,
    } = req.body;

    if (!depositedAmount || !parcelIds || parcelIds.length === 0) {
      return res
        .status(400)
        .send({
          success: false,
          message: "Missing required fields: depositedAmount or parcelIds",
        });
    }

    const depositInvoice = {
      hubName,
      depositedAmount,
      totalParcelsCovered: parcelIds.length,
      parcelIds,
      paymentMethod: paymentMethod || "CASH",
      transactionDetails: transactionDetails || {},
      status: "pending",
      submittedBy: submittedBy || "Hub Manager",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const insertResult = await hqPaymentsCollections.insertOne(depositInvoice);

    if (insertResult.insertedId) {
      const objectIdArray = parcelIds.map((id) => new ObjectId(id));
      await parcelsCollections.updateMany(
        { _id: { $in: objectIdArray } },
        {
          $set: {
            depositRequestStatus: "submitted",
            hqPaymentInvoiceId: insertResult.insertedId,
          },
        },
      );

      depositHistoryCache.bump(hubName);
      hubHandCashCache.del(`hub_hand_cash_${hubName}`);
      managerCache.bump("global");
    }

    res
      .status(201)
      .send({
        success: true,
        message: "Deposit request submitted to HQ successfully!",
        depositId: insertResult.insertedId,
      });
  } catch (error) {
    console.error("Deposit HQ Error:", error);
    res
      .status(500)
      .send({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
  }
});

const pendingDepositHistoryRequests = new Map();
app.get(
  "/hub-deposit-history",
  verifyFireBaseToken,
  verifyRoles("hub-manager", "admin"),
  async (req, res) => {
    try {
      const { hubName, status } = req.query;
      const owner = hubName || "global";
      const cachedString = depositHistoryCache.get(owner, [status || "all"]);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      const cacheDedupeKey = `${owner}:${status || "all"}`;
      if (!pendingDepositHistoryRequests.has(cacheDedupeKey)) {
        const fetchPromise = (async () => {
          const { hqPaymentsCollections } = await connectDB();
          const query = {};
          if (hubName) query.hubName = hubName;
          if (status) query.status = status;

          const depositHistory = await hqPaymentsCollections
            .find(query)
            .sort({ createdAt: -1 })
            .toArray();
          const responseData = {
            success: true,
            hubName,
            totalDeposits: depositHistory.length,
            history: depositHistory,
          };
          const jsonString = JSON.stringify(responseData);
          depositHistoryCache.set(owner, [status || "all"], jsonString);
          return jsonString;
        })();
        pendingDepositHistoryRequests.set(cacheDedupeKey, fetchPromise);
      }

      const jsonString =
        await pendingDepositHistoryRequests.get(cacheDedupeKey);
      pendingDepositHistoryRequests.delete(cacheDedupeKey);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      const { hubName, status } = req.query;
      pendingDepositHistoryRequests.delete(
        `${hubName || "global"}:${status || "all"}`,
      );
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

app.patch(
  "/approve-deposit/:id",
  verifyFireBaseToken,
  verifyAdminToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { hqPaymentsCollections, parcelsCollections } = await connectDB();
      const invoice = await hqPaymentsCollections.findOne({
        _id: new ObjectId(id),
      });
      const objectParcelIds = invoice.parcelIds.map((pid) => new ObjectId(pid));

      await hqPaymentsCollections.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "approved", approvedAt: new Date().toISOString() } },
      );
      await parcelsCollections.updateMany(
        { _id: { $in: objectParcelIds } },
        { $set: { isDepositedToHQ: true, depositRequestStatus: "approved" } },
      );

      depositHistoryCache.bump(invoice.hubName);
      depositHistoryCache.bump("global");
      hubHandCashCache.del(`hub_hand_cash_${invoice.hubName}`);
      hubProfitCache.del(`hub_profit_metrics_${invoice.hubName}`);
      lateInvoicesCache.flushAll();
      mainDashboardCache.del("master_admin_main_dashboard");

      res.send({ success: true, message: "Deposit approved successfully!" });
    } catch (error) {
      res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  },
);

/* ---- Master Admin ---- */
const pendingDashboardRequests = new Map();
app.get("/master-admin/main-dashboard", async (req, res) => {
  try {
    const cacheKey = "master_admin_main_dashboard";
    const cachedString = mainDashboardCache.get(cacheKey);
    if (cachedString) {
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(cachedString);
    }

    if (!pendingDashboardRequests.has(cacheKey)) {
      const fetchPromise = (async () => {
        const { parcelsCollections, merchantsCollections, ridersCollections } =
          await connectDB();

        const revenueResult = await parcelsCollections
          .aggregate([
            { $match: { deliveryStatus: "delivered" } },
            { $group: { _id: null, total: { $sum: "$deliveryCharge" } } },
          ])
          .toArray();
        const totalRevenue =
          revenueResult.length > 0 ? revenueResult[0].total : 0;

        const totalParcels = await parcelsCollections.estimatedDocumentCount();
        const totalMerchants =
          await merchantsCollections.estimatedDocumentCount();
        const activeRiders = await ridersCollections.countDocuments({
          currentTasks: { $gt: 0 },
        });
        const pendingPickUpAndDeliveryCount =
          await parcelsCollections.countDocuments({
            deliveryStatus: {
              $in: ["assign-pickup-rider", "assign-delivery-rider"],
            },
          });
        const inTransitAndPickedCount = await parcelsCollections.countDocuments(
          { deliveryStatus: { $in: ["rider-carrying", "in-transit"] } },
        );
        const dispatchCount = await parcelsCollections.countDocuments({
          deliveryStatus: "delivered",
        });

        const transitLiquidityResult = await parcelsCollections
          .aggregate([
            {
              $match: {
                status: "delivered",
                revMethod: "COD",
                isDepositedToHQ: false,
              },
            },
            { $group: { _id: null, totalTransitCash: { $sum: "$codAmount" } } },
          ])
          .toArray();
        const codInTransit =
          transitLiquidityResult.length > 0
            ? transitLiquidityResult[0].totalTransitCash
            : 0;

        const recentParcels = await parcelsCollections
          .find({})
          .sort({ createdAt: -1 })
          .limit(3)
          .project({
            trackingID: 1,
            "senderInfo.name": 1,
            "receiverInfo.name": 1,
            deliveryStatus: 1,
            codAmount: 1,
          })
          .toArray();

        const responseData = {
          success: true,
          metrics: {
            totalRevenue,
            totalParcels,
            totalMerchants,
            activeRiders,
            codInTransit,
          },
          pipeline: {
            pendingPickUpAndDeliveryCount,
            inTransitAndPickedCount,
            dispatchCount,
          },
          recentParcels,
        };
        const jsonString = JSON.stringify(responseData);
        mainDashboardCache.set(cacheKey, jsonString);
        return jsonString;
      })();
      pendingDashboardRequests.set(cacheKey, fetchPromise);
    }

    const jsonString = await pendingDashboardRequests.get(cacheKey);
    pendingDashboardRequests.delete(cacheKey);
    res.setHeader("Content-Type", "application/json");
    res.status(200).send(jsonString);
  } catch (error) {
    pendingDashboardRequests.delete("master_admin_main_dashboard");
    console.error("Main Dashboard Error:", error);
    res.status(500).send({ success: false, message: "Internal Server Error" });
  }
});

app.get("/", (req, res) => res.send("🚀 TradeCen Server Running"));

/* ----- Payment Method -----*/
app.post("/payment-checkout", async (req, res) => {
  const paymentInfo = req.body;
  const amount = parseInt(paymentInfo.deliveryCharge) * 100;
  const session = await stripe.checkout.sessions.create({
    line_items: [
      {
        price_data: {
          currency: "USD",
          unit_amount: amount,
          product_data: {
            name: `Payment checkout for ${paymentInfo.parcelName}`,
          },
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    metadata: {
      parcelId: paymentInfo.parcelId,
      percelName: paymentInfo.percelName,
      trackingID: paymentInfo.trackingID,
    },
    customer_email: paymentInfo.senderEmail,
    success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
  });
  res.send({ url: session.url });
});

app.patch("/verify-payment", async (req, res) => {
  const { paymentCollections, parcelsCollections } = await connectDB();
  const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
  const transactionId = session.payment_intent;

  const paymentExisted = await paymentCollections.findOne({ transactionId });
  if (paymentExisted) {
    return res.send({
      message: "Already exist",
      ...paymentExisted,
      transactionId,
      trackingID: paymentExisted.trackingID,
    });
  }

  const trackingID = session.metadata.trackingID;
  if (session.payment_status === "paid") {
    const parcel = await parcelsCollections.findOneAndUpdate(
      { _id: new ObjectId(session.metadata.parcelId) },
      {
        $set: {
          deliveryChargeStatus: "paid",
          deliveryChargeOnlinePaymentStatus: true,
        },
      },
      { returnDocument: "after" },
    );

    const paymentHistory = {
      product: session.metadata.percelName,
      amount: session.amount_total / 100,
      customer_email: session.customer_email,
      transactionId,
      trackingID,
      paidAt: new Date(),
    };
    await paymentCollections.insertOne(paymentHistory);

    invalidateParcelStatusChange({
      trackingID,
      senderEmail: parcel?.senderInfo?.email,
      originHub: parcel?.serviceCenters?.origin,
      destinationHub: parcel?.serviceCenters?.destination,
      parcelId: session.metadata.parcelId,
    });
    if (parcel?.senderInfo?.email)
      revenueStatsCache.bump(parcel.senderInfo.email);
    mainDashboardCache.del("master_admin_main_dashboard");

    return res.send({
      success: true,
      ...paymentHistory,
      transactionId,
      trackingID,
    });
  }
  res.send({ success: false });
});

/* ----- OTP SYSTEM (Express Routes) -----*/
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
});

app.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).send({ error: "Email is required" });
  try {
    const otp = Math.floor(100000 + Math.random() * 900000);
    await admin
      .firestore()
      .collection("otps")
      .doc(email)
      .set({ otp, expiresAt: Date.now() + 5 * 60 * 1000 });
    await transporter.sendMail({
      from: `"TradeCen" <${process.env.EMAIL}>`,
      to: email,
      subject: "Your OTP Code",
      text: `Your OTP is ${otp}. It will expire in 5 minutes.`,
    });
    res.send({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error("Error sending OTP:", error);
    res.status(500).send({ error: error.message });
  }
});

app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  try {
    const doc = await admin.firestore().collection("otps").doc(email).get();
    if (!doc.exists)
      return res.status(404).send({ error: "OTP not found. Please resend." });

    const stored = doc.data();
    if (Date.now() > stored.expiresAt)
      return res.status(400).send({ error: "OTP has expired" });
    if (parseInt(otp) !== stored.otp)
      return res.status(400).send({ error: "Invalid OTP code" });

    res.send({ success: true, message: "OTP verified" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

app.post("/reset-password", async (req, res) => {
  const { email, newPassword } = req.body;
  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(user.uid, { password: newPassword });
    await admin.firestore().collection("otps").doc(email).delete();
    res.send({ success: true, message: "Password updated successfully" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

/* ---- START SERVER ---- */
connectDB()
  .then(() => {
    console.log("🚀 MongoDB Connected");
    const server = app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err);
  });
