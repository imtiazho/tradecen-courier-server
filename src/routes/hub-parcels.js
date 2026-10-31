const express = require("express");
const createParcelController = require("../controllers/parcelController");

function createHubParcelsRouter(dependencies) {
  const router = express.Router();
  const controller = createParcelController(dependencies);
  const { verifyFireBaseToken, verifyHubManagerToken } = dependencies;

  router.get("/parcels/incoming/:hubName", controller.getIncomingParcels);

  router.get(
    "/parcels/pickups/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.getPickupParcels,
  );

  router.get(
    "/warehouse/sorting-house/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.getSortingHouseParcels,
  );

  router.get(
    "/parcels/out-for-delivery/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.getOutForDeliveryParcels,
  );

  router.get(
    "/parcels/hub-delivered/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.getHubDeliveredParcels,
  );

  router.patch(
    "/parcels/dispatch/:id",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.dispatchParcel,
  );

  router.patch(
    "/parcels/dest-hub/received/:id",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.receiveParcelAtDestinationHub,
  );

  router.patch(
    "/parcels/origin-hub/received/:id",
    verifyFireBaseToken,
    verifyHubManagerToken,
    controller.receiveParcelAtOriginHub,
  );

  return router;
}

module.exports = createHubParcelsRouter;
