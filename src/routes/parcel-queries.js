const express = require("express");
const createParcelController = require("../controllers/parcelController");

function createParcelQueriesRouter(dependencies) {
  const router = express.Router();
  const controller = createParcelController(dependencies);
  const { verifyFireBaseToken, verifyOwner, verifyMerchantToken } = dependencies;

  router.get(
    "/parcels",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getMerchantParcels,
  );

  router.get("/parcel/:parcelID", controller.getParcelById);

  router.get(
    "/late-invoices/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getLateInvoices,
  );

  router.get("/parcels/unpaid/:email", controller.getUnpaidParcels);

  router.get("/parcels/status/:email", controller.getParcelsByStatus);

  router.get(
    "/parcels/stats/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getParcelStats,
  );

  router.get(
    "/revenue/stats/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getRevenueStats,
  );

  router.get("/tracking/:id", controller.getTrackingLogs);

  router.post(
    "/parcels",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.createParcel,
  );

  router.delete(
    "/parcel/:id",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.deleteParcel,
  );

  return router;
}

module.exports = createParcelQueriesRouter;
