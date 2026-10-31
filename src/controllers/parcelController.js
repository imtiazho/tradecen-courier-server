function createParcelController(dependencies) {
  const {
    managerCache,
    incomingParcelsCache,
    pickupCache,
    sortingCache,
    outForDeliveryCache,
    hubDeliveredCache,
    logTracking,
    invalidateParcelStatusChange,
    ObjectId,
    connectDB,
    trackingCache,
    merchantParcelsCache,
    parcelDetailCache,
    lateInvoicesCache,
    merchantUnpaidCache,
    parcelsStatusWiseCache,
    parcelStatsCache,
    revenueStatsCache,
    hubAgingCache,
    hubEfficiencyCache,
    pendingRequests,
  } = dependencies;

  return {
    getIncomingParcels: async (req, res) => {
      try {
        const hubName = req.params.hubName;
        const cacheKey = `incoming_parcels_${hubName}`;
        const cachedData = incomingParcelsCache.get(cacheKey);
        if (cachedData) return res.status(200).send(cachedData);

        const { parcelsCollections } = await connectDB();
        const query = {
          $or: [
            {
              "serviceCenters.origin": hubName,
              deliveryStatus: "parcel-created",
            },
            {
              "serviceCenters.origin": hubName,
              deliveryStatus: "assign-pickup-rider",
            },
            {
              "serviceCenters.destination": hubName,
              deliveryStatus: "in-transit",
            },
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
        res.status(500).send({
          message: "Error fetching incoming parcels",
          error: error.message,
        });
      }
    },
    getPickupParcels: async (req, res) => {
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
        res.status(500).send({
          message: "Error fetching incoming parcels",
          error: error.message,
        });
      }
    },
    getSortingHouseParcels: async (req, res) => {
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
    getOutForDeliveryParcels: async (req, res) => {
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
    getHubDeliveredParcels: async (req, res) => {
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
    dispatchParcel: async (req, res) => {
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
    receiveParcelAtDestinationHub: async (req, res) => {
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
    receiveParcelAtOriginHub: async (req, res) => {
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
    getMerchantParcels: async (req, res) => {
      try {
        const { email, filter, search, status } = req.query;
        const { parcelsCollections } = await connectDB();
        const skip = parseInt(req.query.skip) || 0;
        const limit = parseInt(req.query.limit) || 10;

        const params = [filter || "all", status || "all", skip, limit];
        const cachedData = merchantParcelsCache.get(
          email.toLowerCase(),
          params,
        );
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
    getParcelById: async (req, res) => {
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
        res
          .status(500)
          .send({ success: false, error: "Internal Server Error" });
      }
    },
    getLateInvoices: async (req, res) => {
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
    getUnpaidParcels: async (req, res) => {
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
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
    getParcelsByStatus: async (req, res) => {
      try {
        const email = req.params.email;
        const status = req.query.status;
        const cachedString = parcelsStatusWiseCache.get(email, [
          status || "all",
        ]);
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
    },
    getParcelStats: async (req, res) => {
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
    getRevenueStats: async (req, res) => {
      try {
        const email = req.params.email;
        const { filter } = req.query;
        const cachedString = revenueStatsCache.get(email, [
          filter || "default",
        ]);
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
    getTrackingLogs: async (req, res) => {
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
    },
    createParcel: async (req, res) => {
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
    deleteParcel: async (req, res) => {
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
  };
}

module.exports = createParcelController;
