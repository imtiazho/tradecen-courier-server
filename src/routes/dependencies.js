const NodeCache = require("node-cache");
const nodemailer = require("nodemailer");
const stripeFactory = require("stripe");
const { ObjectId } = require("mongodb");

function createRouteDependencies({ admin, connectDB }) {
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
      return res.status(403).send({
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

  const stripe = stripeFactory(process.env.STRIPE_SECRET);

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

  const pendingRequests = new Map();
  const pendingHubRequests = new Map();
  const pendingHubProfitRequests = new Map();
  const pendingHubAgingRequests = new Map();
  const pendingHubEfficiencyRequests = new Map();
  const pendingDepositHistoryRequests = new Map();
  const pendingDashboardRequests = new Map();

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL, pass: process.env.EMAIL_PASS },
  });

  return { trackingCache, usersCache, userCache, userRoleCache, managerCache, incomingParcelsCache, merchantParcelsCache, pickupCache, sortingCache, outForDeliveryCache, hubDeliveredCache, riderCache, ridersCache, availableRidersCache, returnWarehouseCache, allMerchantsCache, merchantsAreaWiseCache, targetedMerchantCache, payoutSummaryCache, allPayoutsCache, parcelDetailCache, lateInvoicesCache, merchantUnpaidCache, parcelsStatusWiseCache, parcelStatsCache, revenueStatsCache, hubHandCashCache, hubProfitCache, hubAgingCache, hubEfficiencyCache, depositHistoryCache, mainDashboardCache, verifyFireBaseToken, verifyRoles, verifyOwner, verifyAdminToken, verifyMerchantToken, verifyRiderToken, verifyHubManagerToken, stripe, logTracking, invalidateParcelStatusChange, pendingRequests, pendingHubRequests, pendingHubProfitRequests, pendingHubAgingRequests, pendingHubEfficiencyRequests, pendingDepositHistoryRequests, pendingDashboardRequests, ObjectId, connectDB, admin, transporter };
}

module.exports = createRouteDependencies;
