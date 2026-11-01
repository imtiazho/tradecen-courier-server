const express = require("express");

function createRidersRouter(dependencies) {
  const router = express.Router();
  const { usersCache, userCache, userRoleCache, managerCache, mainDashboardCache, riderCache, ridersCache, availableRidersCache, returnWarehouseCache, targetedMerchantCache, verifyFireBaseToken, verifyRoles, verifyOwner, verifyAdminToken, verifyRiderToken, verifyHubManagerToken, verifyAssignedHub, logTracking, invalidateParcelStatusChange, ObjectId, connectDB, withTransaction, admin } = dependencies;

  const riderProfileCacheKey = (email) => `rider_${encodeURIComponent(email)}`;
  const riderListCacheScope = (area) => area ? `area:${encodeURIComponent(area)}` : "global";
  const availableRiderCacheKey = (area) => `available_riders_${encodeURIComponent(area.toLowerCase())}`;

  function invalidateRiderCaches({
    rider,
    email,
    area,
    riderDocumentChanged = false,
    availabilityChanged = false,
    activeTaskCountChanged = false,
  }) {
    const riderEmails = new Set([email, rider?.email].filter(Boolean));
    const riderArea = area || rider?.area;
    for (const riderEmail of riderEmails) {
      riderCache.del(riderProfileCacheKey(riderEmail));
    }

    if (riderDocumentChanged) {
      const scopes = new Set(["global"]);
      if (riderArea) scopes.add(riderListCacheScope(riderArea));
      for (const scope of scopes) ridersCache.bump(scope);
    }

    if (availabilityChanged && riderArea) {
      availableRidersCache.del(availableRiderCacheKey(riderArea));
    }

    if (activeTaskCountChanged) {
      mainDashboardCache.del("master_admin_main_dashboard");
    }
  }

  const resolveAuthenticatedRider = async (req, res, next) => {
    try {
      const { ridersCollections } = await connectDB();
      const rider = await ridersCollections.findOne({
        email: req.decoded_email,
      });
      if (!rider) {
        return res
          .status(404)
          .send({ success: false, message: "Rider not found in TradeCen" });
      }
      req.authenticatedRider = rider;
      return next();
    } catch (error) {
      return res
        .status(500)
        .send({ success: false, message: "Internal Server Error" });
    }
  };
  resolveAuthenticatedRider.auditName = "resolveAuthenticatedRider";

  const verifyRoleSpecificRiderListing = async (req, res, next) => {
    if (req.authorizationRole === "hub-manager") {
      return verifyAssignedHub(req, res, () => {
        if (
          req.query.area !== undefined &&
          req.query.area !== req.assignedHubName
        ) {
          return res.status(403).send({
            success: false,
            message: "Forbidden: You cannot access another hub's Riders",
          });
        }
        return next();
      });
    }
    if (req.authorizationRole === "rider") {
      if (
        req.query.email !== undefined &&
        req.query.email !== req.decoded_email
      ) {
        return res.status(403).send({
          success: false,
          message: "Forbidden: You cannot access another Rider's data",
        });
      }
      return resolveAuthenticatedRider(req, res, next);
    }
    return next();
  };
  verifyRoleSpecificRiderListing.auditName = "verifyRoleSpecificRiderListing";

  router.get(
    "/rider/:email",
    verifyFireBaseToken,
    verifyRiderToken,
    verifyOwner,
    resolveAuthenticatedRider,
    async (req, res) => {
    try {
      const email = req.decoded_email;
      const cacheKey = riderProfileCacheKey(email);
      const cachedData = riderCache.get(cacheKey);
      if (cachedData) return res.status(200).send(cachedData);

      const { parcelsCollections } = await connectDB();
      const riderData = req.authenticatedRider;

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

  router.patch(
    "/rider/status/:email",
    verifyFireBaseToken,
    verifyRiderToken,
    verifyOwner,
    resolveAuthenticatedRider,
    async (req, res) => {
    try {
      const { ridersCollections } = await connectDB();
      const { workStatus } = req.body;
      const email = req.decoded_email;
      if (!["available", "offline"].includes(workStatus)) {
        return res.status(400).send({
          success: false,
          message: "Invalid work status",
        });
      }

      const result = await ridersCollections.updateOne(
        { _id: req.authenticatedRider._id, email },
        { $set: { workStatus } },
      );

      if (result.modifiedCount > 0 || result.matchedCount > 0) {
        invalidateRiderCaches({
          rider: req.authenticatedRider,
          email,
          riderDocumentChanged: true,
          availabilityChanged: true,
        });

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
    },
  );

  router.patch(
    "/riders/hold-parcel/update",
    verifyFireBaseToken,
    verifyRiderToken,
    async (req, res) => {
      try {
        const { ridersCollections, parcelsCollections } = await connectDB();
        const { riderId, parcelId } = req.body;
        const rider = await ridersCollections.findOne({
          _id: new ObjectId(riderId),
        });

        await ridersCollections.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { "activeTasks.$[elem].isHold": true } },
          { arrayFilters: [{ "elem.parcelId": new ObjectId(parcelId) }] },
        );
        invalidateRiderCaches({
          rider,
          riderDocumentChanged: true,
        });
        await parcelsCollections.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { deliveryStatus: "hold" } },
        );
        if (rider?.email) invalidateRiderCaches({ email: rider.email });

        const parcelData = await parcelsCollections.findOne({
          _id: new ObjectId(parcelId),
        });
        invalidateParcelStatusChange({
          trackingID: parcelData.trackingID,
          senderEmail: parcelData.senderInfo?.email,
          originHub: parcelData.serviceCenters?.origin,
          destinationHub: parcelData.serviceCenters?.destination,
          parcelId,
        });
        await logTracking(parcelData, "hold-up");

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

  router.post("/riders", verifyFireBaseToken, async (req, res) => {
    try {
      const { ridersCollections, userCollections } = await connectDB();
      const email = req.decoded_email;
      const {
        name, photoURL, region, district, area, nid, phone, vehicle, license,
        bikeModel, bikeRegistration, latitude, longitude,
      } = req.body;
      const riderProfile = {
        name, email, photoURL, region, district, area, nid, phone, vehicle,
        license, bikeModel, bikeRegistration, latitude, longitude,
        status: "pending",
        workStatus: "Not Confirmed",
        createdAt: new Date(),
        currentLocation: { latitude, longitude },
        avgDeliveryTime: 0,
        successRate: 0,
        rating: 0,
        totalEarnings: 0,
        currentTasks: 0,
        totalAssign: 0,
        successfullyComplete: 0,
        bloodGroup: "A+",
      };

      let createdResult;
      let outcome;
      await withTransaction(async (session) => {
        const user = await userCollections.findOne({ email }, { session });
        if (!user) {
          outcome = "user-not-found";
          return;
        }
        const existingRider = await ridersCollections.findOne({ email }, { session });
        if (existingRider) {
          outcome = "already-exists";
          return;
        }
        if (user.role !== "user") {
          outcome = "role-not-eligible";
          return;
        }

        const claim = await userCollections.updateOne(
          { email, role: "user" },
          { $set: { role: "pending-rider" } },
          { session },
        );
        if (claim.matchedCount === 0) {
          outcome = "role-not-eligible";
          return;
        }
        createdResult = await ridersCollections.insertOne(riderProfile, { session });
        outcome = "created";
      });

      if (outcome === "user-not-found") {
        return res.status(404).send({ success: false, message: "User not found" });
      }
      if (outcome === "role-not-eligible") {
        return res.status(409).send({
          success: false,
          message: "This account cannot submit a Rider application",
        });
      }
      if (outcome === "already-exists") {
        return res.send({ message: "This email already used for rider!" });
      }

      invalidateRiderCaches({
        rider: riderProfile,
        riderDocumentChanged: true,
        availabilityChanged: true,
      });
      userCache.del("user_" + email);
      userRoleCache.del("user_role_" + email);
      usersCache.bump("global");
      return res.send(createdResult);
    } catch (error) {
      return res.status(500).send({ error: "Internal Server Error" });
    }
  });

  router.get(
    "/riders",
    verifyFireBaseToken,
    verifyRoles("admin", "hub-manager", "rider"),
    verifyRoleSpecificRiderListing,
    async (req, res) => {
      try {
        const { status, workStatus, email } = req.query;
        const isAdmin = req.authorizationRole === "admin";
        const isHubManager = req.authorizationRole === "hub-manager";
        if (req.authorizationRole === "rider") {
          return res.status(200).send([req.authenticatedRider]);
        }

        const area = isHubManager ? req.assignedHubName : req.query.area;
        const scopedEmail = isAdmin ? email : undefined;
        const owner = isHubManager
          ? riderListCacheScope(req.assignedHubName)
          : "global";
        const cacheFilters = {
          area: area || null,
          status: status || null,
          workStatus: workStatus || null,
          email: scopedEmail || null,
        };
        const cachedData = ridersCache.get(owner, [
          JSON.stringify(cacheFilters),
        ]);
        if (cachedData) return res.status(200).send(cachedData);

        const { ridersCollections } = await connectDB();
        let query = {};
        if (status) query.status = status;
        if (workStatus) query.workStatus = workStatus;
        if (scopedEmail) query.email = scopedEmail;
        if (area) query.area = area;

        const result = await ridersCollections.find(query).toArray();
        ridersCache.set(
          owner,
          [JSON.stringify(cacheFilters)],
          result,
        );
        res.status(200).send(result);
      } catch (error) {
        console.error("Error fetching riders:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    },
  );

  router.get(
    "/riders/available/:areaName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    async (req, res) => {
      try {
        const areaName = req.assignedHubName;
        const cacheKey = availableRiderCacheKey(areaName);
        const cachedRiders = availableRidersCache.get(cacheKey);
        if (cachedRiders) return res.status(200).send(cachedRiders);

        const { ridersCollections } = await connectDB();
        const query = {
          area: areaName,
          workStatus: "available",
          currentTasks: { $lt: 10 },
        };
        const riders = await ridersCollections
          .find(query)
          .project({ _id: 1, name: 1, phone: 1, currentTasks: 1 })
          .toArray();
        availableRidersCache.set(cacheKey, riders);
        res.status(200).send(riders);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error fetching riders", error: error.message });
      }
    },
  );

  router.patch(
    "/riders/:id",
    verifyFireBaseToken,
    verifyAdminToken,
    async (req, res) => {
      try {
        const { ridersCollections, userCollections } = await connectDB();
        const id = req.params.id;
        if (!/^[a-f\d]{24}$/i.test(id || "")) {
          return res.status(400).send({ success: false, message: "Invalid Rider ID" });
        }
        const { status, workStatus } = req.body;
        let existingRider;
        let riderResult;
        let userResult;
        let outcome;
        await withTransaction(async (session) => {
          existingRider = await ridersCollections.findOne(
            { _id: new ObjectId(id) },
            { session },
          );
          if (!existingRider) {
            outcome = "rider-not-found";
            return;
          }
          riderResult = await ridersCollections.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, workStatus, updatedAt: new Date() } },
            { session },
          );
          if (riderResult.modifiedCount === 0) {
            outcome = "rider-not-updated";
            return;
          }
          userResult = await userCollections.updateOne(
            { email: existingRider.email },
            { $set: { role: "rider" } },
            { session },
          );
          if (userResult.matchedCount === 0) {
            const error = new Error("Rider account record not found");
            error.code = "RIDER_ACCOUNT_NOT_FOUND";
            throw error;
          }
          outcome = "approved";
        });

        if (outcome !== "approved") {
          return res.status(404).send({
            message:
              outcome === "rider-not-found"
                ? "Rider not found"
                : "Rider not found or no changes made",
          });
        }
        invalidateRiderCaches({
          rider: existingRider,
          email: existingRider.email,
          riderDocumentChanged: true,
          availabilityChanged: true,
        });
        userCache.del("user_" + existingRider.email);
        userRoleCache.del("user_role_" + existingRider.email);
        usersCache.bump("global");
        return res.send({
          success: true,
          message: "Rider approved and user role updated to rider",
          riderResult,
          userResult,
        });
      } catch (error) {
        if (error.code === "RIDER_ACCOUNT_NOT_FOUND") {
          return res.status(404).send({
            success: false,
            message: "User account for this Rider was not found",
          });
        }
        console.error("Error approving rider:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    },
  );

  const createParcelAssignmentHandler = ({
    hubField,
    allowedStatuses,
    riderField,
    taskType,
  }) => async (req, res) => {
    const { parcelId, riderId } = req.body || {};
    if (!/^[a-f\d]{24}$/i.test(String(parcelId || "")) || !/^[a-f\d]{24}$/i.test(String(riderId || ""))) {
      return res.status(400).send({ success: false, message: "Invalid parcel or Rider ID" });
    }

    try {
      const { parcelsCollections, ridersCollections } = await connectDB();
      const parcelObjectId = new ObjectId(parcelId);
      const riderObjectId = new ObjectId(riderId);
      const [parcel, rider] = await Promise.all([
        parcelsCollections.findOne({ _id: parcelObjectId }),
        ridersCollections.findOne({ _id: riderObjectId }),
      ]);
      if (!parcel) {
        return res.status(404).send({ success: false, message: "Parcel not found" });
      }
      if (parcel.serviceCenters?.[hubField] !== req.assignedHubName) {
        return res.status(403).send({
          success: false,
          message: "Forbidden: Parcel does not belong to your assigned hub",
        });
      }
      if (!allowedStatuses.includes(parcel.deliveryStatus)) {
        return res.status(409).send({
          success: false,
          message: "Parcel is not in an assignable state",
        });
      }
      if (!rider) {
        return res.status(404).send({ success: false, message: "Rider not found" });
      }
      if (rider.area !== req.assignedHubName) {
        return res.status(403).send({
          success: false,
          message: "Forbidden: Rider does not belong to your assigned hub",
        });
      }
      if (rider.workStatus !== "available" || Number(rider.currentTasks) >= 10) {
        return res.status(409).send({
          success: false,
          message: "Rider is not available for assignment",
        });
      }

      const assignedAt = new Date();
      const parcelAssignment = {
        id: String(rider._id),
        name: rider.name,
        email: rider.email,
        phone: rider.phone,
        assignedAt,
      };
      const activeTask = taskType === "pickup"
        ? {
            parcelId: parcelObjectId,
            trackingID: parcel.trackingID,
            parcelName: parcel.parcelName,
            codAmount: parcel.codAmount,
            pickupLocation: parcel.senderInfo?.address,
            merchantName: parcel.senderInfo?.name,
            merchantPhone: parcel.senderInfo?.phone,
            taskType,
            assignedAt,
          }
        : {
            parcelId: parcelObjectId,
            trackingID: parcel.trackingID,
            parcelName: parcel.parcelName,
            codAmount: parcel.codAmount,
            deliveryLocation: parcel.receiverInfo?.address,
            consumerName: parcel.receiverInfo?.name,
            consumerPhone: parcel.receiverInfo?.phone,
            taskType,
            assignedAt,
            isHold: false,
          };
      const parcelStatusFilter = allowedStatuses.length === 1
        ? allowedStatuses[0]
        : { $in: allowedStatuses };

      try {
        const result = await withTransaction(async (session) => {
          const parcelUpdate = await parcelsCollections.updateOne(
            {
              _id: parcelObjectId,
              ["serviceCenters." + hubField]: req.assignedHubName,
              deliveryStatus: parcelStatusFilter,
            },
            {
              $set: {
                deliveryStatus: taskType === "pickup"
                  ? "assign-pickup-rider"
                  : "assign-delivery-rider",
                [riderField]: parcelAssignment,
                updatedAt: assignedAt,
              },
            },
            { session },
          );
          if (parcelUpdate.matchedCount === 0) return "parcel-conflict";

          const riderUpdate = await ridersCollections.updateOne(
            {
              _id: rider._id,
              email: rider.email,
              area: req.assignedHubName,
              workStatus: "available",
              currentTasks: { $lt: 10 },
            },
            {
              $inc: { currentTasks: 1, totalAssign: 1 },
              $push: { activeTasks: activeTask },
            },
            { session },
          );
          if (riderUpdate.matchedCount === 0) {
            const error = new Error("Rider is no longer eligible for assignment");
            error.code = "RIDER_ASSIGNMENT_CONFLICT";
            throw error;
          }
          return "assigned";
        });

        if (result !== "assigned") {
          return res.status(409).send({
            success: false,
            message: "Parcel is no longer available for assignment",
          });
        }
      } catch (error) {
        if (error.code === "RIDER_ASSIGNMENT_CONFLICT") {
          return res.status(409).send({
            success: false,
            message: "Rider is no longer available for assignment",
          });
        }
        throw error;
      }

      await logTracking(
        parcel,
        taskType === "pickup" ? "assign-pickup-rider" : "assign-delivery-rider",
      );
      invalidateParcelStatusChange({
        trackingID: parcel.trackingID,
        senderEmail: parcel.senderInfo?.email,
        originHub: parcel.serviceCenters?.origin,
        destinationHub: parcel.serviceCenters?.destination,
        parcelId,
      });
      invalidateRiderCaches({
        rider,
        email: rider.email,
        riderDocumentChanged: true,
        availabilityChanged: true,
        activeTaskCountChanged: true,
      });
      if (taskType === "delivery") managerCache.bump("global");

      return res.status(200).send({
        success: true,
        message: "Rider assigned successfully",
      });
    } catch (error) {
      return res.status(500).send({
        message: "Server error",
        error: "Internal Server Error",
      });
    }
  };

  router.patch(
    "/parcels/assign-rider",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    createParcelAssignmentHandler({
      hubField: "origin",
      allowedStatuses: ["parcel-created"],
      riderField: "pickupRider",
      taskType: "pickup",
    }),
  );

  router.patch(
    "/parcels/assign-delivery",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    createParcelAssignmentHandler({
      hubField: "destination",
      allowedStatuses: [
        "reached-destination-warehouse",
        "reached-origin-warehouse",
      ],
      riderField: "deliveryRider",
      taskType: "delivery",
    }),
  );
  router.patch("/parcels/assign-return-delivery", async (req, res) => {
    try {
      const { parcelId, riderId, riderName, riderEmail, riderPhone, trackingID } =
        req.body;
      const { parcelsCollections, ridersCollections } = await connectDB();
      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });
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
      if (parcelUpdate.modifiedCount > 0) {
        invalidateParcelStatusChange({
          trackingID: parcelData.trackingID,
          senderEmail: parcelData.senderInfo?.email,
          originHub: parcelData.serviceCenters?.origin,
          destinationHub: parcelData.serviceCenters?.destination,
          parcelId,
        });
        invalidateRiderCaches({ email: riderEmail });
        const originHub = parcelData.serviceCenters?.origin;
        if (originHub) {
          returnWarehouseCache.del(`return_warehouse_${originHub.toLowerCase()}`);
        }
      }
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
      invalidateRiderCaches({
        rider,
        email: riderEmail,
        riderDocumentChanged: true,
        availabilityChanged: true,
        activeTaskCountChanged: true,
      });

      if (parcelUpdate.modifiedCount > 0 && riderUpdate.modifiedCount > 0) {
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

  router.patch("/riders/complete-return-delivered/update", async (req, res) => {
    try {
      const { riderId, parcelId, trackingID } = req.body;
      if (!riderId || !parcelId) {
        return res
          .status(400)
          .send({ success: false, message: "Missing riderId or parcelId" });
      }
      const { parcelsCollections, ridersCollections } = await connectDB();
      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });

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
        return res.status(404).send({
          success: false,
          message: "Parcel not found or already updated",
        });
      }
      invalidateRiderCaches({ email: rider?.email });

      const parcelData = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });
      invalidateParcelStatusChange({
        trackingID: parcelData.trackingID,
        senderEmail: parcelData.senderInfo?.email,
        originHub: parcelData.serviceCenters?.origin,
        destinationHub: parcelData.serviceCenters?.destination,
        parcelId,
      });
      await logTracking(parcelData, "returned-to-merchant");
      await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        {
          $inc: { currentTasks: -1 },
          $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
        },
      );

      invalidateRiderCaches({
        rider,
        riderDocumentChanged: true,
        availabilityChanged: true,
        activeTaskCountChanged: true,
      });

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

  router.patch(
    "/riders/complete-pickup/update",
    verifyFireBaseToken,
    verifyRiderToken,
    async (req, res) => {
      try {
        const { riderId, parcelId, trackingID } = req.body;
        const { parcelsCollections, ridersCollections } = await connectDB();
        const rider = await ridersCollections.findOne({
          _id: new ObjectId(riderId),
        });

        await parcelsCollections.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              deliveryStatus: "picked-up",
              currentLocation: "Picked & On Way",
            },
          },
        );
        invalidateRiderCaches({ email: rider?.email });
        const parcel = await parcelsCollections.findOne({
          _id: new ObjectId(parcelId),
        });
        invalidateParcelStatusChange({
          trackingID: parcel.trackingID,
          senderEmail: parcel.senderInfo?.email,
          originHub: parcel.serviceCenters?.origin,
          destinationHub: parcel.serviceCenters?.destination,
          parcelId,
        });
        await logTracking(parcel, "rider-carrying");

        const result = await ridersCollections.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $inc: { currentTasks: -1, successfullyComplete: 1 },
            $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
          },
        );

        invalidateRiderCaches({
          rider,
          riderDocumentChanged: true,
          availabilityChanged: true,
          activeTaskCountChanged: true,
        });

        res.send({ success: true, result });
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error completing pickup", error: error.message });
      }
    },
  );

  router.patch("/riders/return-req/update", async (req, res) => {
    try {
      const { riderId, parcelId } = req.body;
      const { parcelsCollections, ridersCollections, hubManagersCollection } =
        await connectDB();
      const rider = await ridersCollections.findOne({
        _id: new ObjectId(riderId),
      });

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
      invalidateRiderCaches({ email: rider?.email });
      const parcel = await parcelsCollections.findOne({
        _id: new ObjectId(parcelId),
      });
      const hubName = parcel?.receiverInfo?.area;
      invalidateParcelStatusChange({
        trackingID: parcel.trackingID,
        senderEmail: parcel.senderInfo?.email,
        originHub: parcel.serviceCenters?.origin,
        destinationHub: parcel.serviceCenters?.destination,
        parcelId,
      });
      await logTracking(parcel, "return-requested");

      await ridersCollections.updateOne(
        { _id: new ObjectId(riderId) },
        {
          $inc: { currentTasks: -1 },
          $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
          $push: { returnLedger: { ...parcel, requestedAt: new Date() } },
        },
      );
      invalidateRiderCaches({
        rider,
        riderDocumentChanged: true,
        availabilityChanged: true,
        activeTaskCountChanged: true,
      });
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

  router.patch("/parcels/return-hub/received/:parcelId", async (req, res) => {
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
        return res.status(404).send({
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
      invalidateParcelStatusChange({
        trackingID: parcel.trackingID,
        senderEmail: parcel.senderInfo?.email,
        originHub: parcel.serviceCenters?.origin,
        destinationHub: parcel.serviceCenters?.destination,
        parcelId,
      });

      const riderEmail = parcel?.deliveryRider?.email;
      if (riderEmail) {
        invalidateRiderCaches({ email: riderEmail });
        const rider = await ridersCollections.findOne({ email: riderEmail });
        await ridersCollections.updateOne(
          { email: riderEmail },
          { $pull: { returnLedger: { _id: new ObjectId(parcelId) } } },
        );
        invalidateRiderCaches({
          rider,
          email: riderEmail,
          riderDocumentChanged: true,
        });
      }
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

  router.patch("/hub/dispatch-return-to-origin/:parcelId", async (req, res) => {
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
        return res.status(404).send({
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

  router.patch("/parcels/return-origin-hub/received/:parcelId", async (req, res) => {
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

  router.get(
    "/warehouse/return-house/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    async (req, res) => {
    try {
      const hubName = req.assignedHubName;
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
    },
  );

  router.patch(
    "/riders/complete-delivered/update",
    verifyFireBaseToken,
    verifyRiderToken,
    async (req, res) => {
      try {
        const { riderId, parcelId, trackingID } = req.body;
        const { parcelsCollections, ridersCollections, merchantsCollections } =
          await connectDB();
        const rider = await ridersCollections.findOne({
          _id: new ObjectId(riderId),
        });

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
        invalidateRiderCaches({ email: rider?.email });
        const parcel = await parcelsCollections.findOne({
          _id: new ObjectId(parcelId),
        });
        invalidateParcelStatusChange({
          trackingID: parcel.trackingID,
          senderEmail: parcel.senderInfo?.email,
          originHub: parcel.serviceCenters?.origin,
          destinationHub: parcel.serviceCenters?.destination,
          parcelId,
        });

        const merchantEmail = parcel.senderInfo.email;
        if (merchantEmail) {
          await merchantsCollections.updateOne(
            { email: merchantEmail },
            { $inc: { totalSuccessfulDeliveries: 1 } },
          );
        }

        const riderEmail = rider.email;
        await logTracking(parcel, "delivered");

        const result = await ridersCollections.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $inc: { currentTasks: -1, successfullyComplete: 1 },
            $pull: { activeTasks: { parcelId: new ObjectId(parcelId) } },
          },
        );

        if (merchantEmail) targetedMerchantCache.del(`merchant_${merchantEmail}`);
        invalidateRiderCaches({
          rider,
          email: riderEmail,
          riderDocumentChanged: true,
          availabilityChanged: true,
          activeTaskCountChanged: true,
        });

        res.send({ success: true, result });
      } catch (error) {
        res
          .status(500)
          .send({ message: "Error completing pickup", error: error.message });
      }
    },
  );

  router.delete(
    "/riders/:id",
    verifyFireBaseToken,
    verifyAdminToken,
    async (req, res) => {
    try {
      const { ridersCollections, userCollections } = await connectDB();
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      let riderData;
      let deleteResult;
      let userUpdateResult;

      await withTransaction(async (session) => {
        riderData = await ridersCollections.findOne(query, { session });
        if (!riderData) return;

        deleteResult = await ridersCollections.deleteOne(query, { session });
        if (deleteResult.deletedCount > 0) {
          userUpdateResult = await userCollections.updateOne(
            { email: riderData.email },
            { $set: { role: "user" } },
            { session },
          );
        }
      });

      if (!riderData) {
        return res
          .status(404)
          .send({ success: false, message: "Rider request not found" });
      }

      if (deleteResult.deletedCount === 0) {
        return res
          .status(404)
          .send({ success: false, message: "Rider request not found" });
      }

      userCache.del(`user_${riderData.email}`);
      userRoleCache.del(`user_role_${riderData.email}`);
      invalidateRiderCaches({
        rider: riderData,
        riderDocumentChanged: true,
        availabilityChanged: true,
        activeTaskCountChanged: true,
      });

      res.send({
        success: true,
        message: "Rider request deleted and user role reset to user",
        deleteResult,
        userUpdateResult,
      });
    } catch (error) {
      console.error("Error rejecting rider:", error);
      res.status(500).send({ success: false, message: "Internal Server Error" });
    }
    },
  );

  return router;
}

module.exports = createRidersRouter;
