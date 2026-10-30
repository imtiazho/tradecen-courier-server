const express = require("express");

function createRidersRouter(dependencies) {
  const router = express.Router();
  const { usersCache, userCache, userRoleCache, managerCache, riderCache, ridersCache, availableRidersCache, returnWarehouseCache, targetedMerchantCache, verifyFireBaseToken, verifyRoles, verifyAdminToken, verifyRiderToken, verifyHubManagerToken, logTracking, invalidateParcelStatusChange, ObjectId, connectDB, withTransaction, admin } = dependencies;

  router.get("/rider/:email", async (req, res) => {
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

  router.patch("/rider/status/:email", async (req, res) => {
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

  router.patch(
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

  router.post("/riders", async (req, res) => {
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

  router.get(
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

  router.get(
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

  router.patch(
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

  router.patch(
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

  router.patch(
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

  router.patch("/parcels/assign-return-delivery", async (req, res) => {
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

  router.patch("/riders/complete-return-delivered/update", async (req, res) => {
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
        return res.status(404).send({
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

  router.patch(
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

  router.patch("/riders/return-req/update", async (req, res) => {
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

  router.get("/warehouse/return-house/:hubName", async (req, res) => {
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

  router.patch(
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

  router.delete("/riders/:id", async (req, res) => {
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
    } catch (error) {
      console.error("Error rejecting rider:", error);
      res.status(500).send({ success: false, message: "Internal Server Error" });
    }
  });

  return router;
}

module.exports = createRidersRouter;
