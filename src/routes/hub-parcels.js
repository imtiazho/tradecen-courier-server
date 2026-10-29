const express = require("express");

function createHubParcelsRouter(dependencies) {
  const router = express.Router();
  const { managerCache, incomingParcelsCache, pickupCache, sortingCache, outForDeliveryCache, hubDeliveredCache, verifyFireBaseToken, verifyHubManagerToken, logTracking, invalidateParcelStatusChange, ObjectId, connectDB } = dependencies;

  router.get("/parcels/incoming/:hubName", async (req, res) => {
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
      res.status(500).send({
        message: "Error fetching incoming parcels",
        error: error.message,
      });
    }
  });

  router.get(
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
        res.status(500).send({
          message: "Error fetching incoming parcels",
          error: error.message,
        });
      }
    },
  );

  router.get(
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

  router.get(
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

  router.get(
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

  router.patch(
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

  router.patch(
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

  router.patch(
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

  return router;
}

module.exports = createHubParcelsRouter;
