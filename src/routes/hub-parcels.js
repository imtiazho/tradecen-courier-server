const express = require("express");
const createParcelController = require("../controllers/parcelController");

function createHubParcelsRouter(dependencies) {
  const router = express.Router();
  const controller = createParcelController(dependencies);
  const { verifyFireBaseToken, verifyHubManagerToken, verifyAssignedHub, verifyParcelHub } = dependencies;

  router.get(
    "/parcels/incoming/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    controller.getIncomingParcels,
  );

  router.get(
    "/parcels/pickups/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    controller.getPickupParcels,
  );

  router.get(
    "/warehouse/sorting-house/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    controller.getSortingHouseParcels,
  );

  router.get(
    "/parcels/out-for-delivery/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    controller.getOutForDeliveryParcels,
  );

  router.get(
    "/parcels/hub-delivered/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    controller.getHubDeliveredParcels,
  );

  router.patch(
    "/parcels/dispatch/:id",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    verifyParcelHub("origin"),
    controller.dispatchParcel,
  );

  router.patch(
    "/parcels/dest-hub/received/:id",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    verifyParcelHub("destination"),
    controller.receiveParcelAtDestinationHub,
  );

  router.patch(
    "/parcels/origin-hub/received/:id",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    verifyParcelHub("origin"),
    controller.receiveParcelAtOriginHub,
  );

  return router;
}

module.exports = createHubParcelsRouter;
