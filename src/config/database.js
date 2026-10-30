const { MongoClient, ServerApiVersion } = require('mongodb');

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

async function closeDB() {
  await client.close();
  db = undefined;
}

async function withTransaction(callback) {
  const session = client.startSession();
  try {
    return await session.withTransaction(() => callback(session));
  } finally {
    await session.endSession();
  }
}

module.exports = { connectDB, closeDB, withTransaction };
