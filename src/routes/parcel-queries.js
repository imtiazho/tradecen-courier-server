const express = require("express");
const createParcelController = require("../controllers/parcelController");

function createParcelQueriesRouter(dependencies) {
  const router = express.Router();
  const controller = createParcelController(dependencies);
  const { verifyFireBaseToken, verifyOwner, verifyMerchantToken, connectDB, ObjectId } = dependencies;

  const verifyParcelOwner = async (req, res, next) => {
    try {
      const id = req.params.parcelID || req.params.id;
      if (!/^[a-f\d]{24}$/i.test(id || "")) {
        return next();
      }
      const { parcelsCollections } = await connectDB();
      const parcel = await parcelsCollections.findOne({ _id: new ObjectId(id) });
      if (!parcel) return next();
      if (parcel.senderInfo?.email !== req.decoded_email) {
        return res.status(403).send({
          success: false,
          message: "Forbidden: You cannot access other user's data",
        });
      }
      next();
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  };

  const verifyParcelPayloadOwner = (req, res, next) => {
    if (req.body.senderInfo?.email !== req.decoded_email) {
      return res.status(403).send({
        success: false,
        message: "Forbidden: You cannot create parcels for another merchant",
      });
    }
    next();
  };

  router.get(
    "/parcels",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getMerchantParcels,
  );

  router.get(
    "/parcel/:parcelID",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyParcelOwner,
    controller.getParcelById,
  );

  router.get(
    "/late-invoices/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getLateInvoices,
  );

  router.get(
    "/parcels/unpaid/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getUnpaidParcels,
  );

  router.get(
    "/parcels/status/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    controller.getParcelsByStatus,
  );

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
    verifyParcelPayloadOwner,
    controller.createParcel,
  );

  router.delete(
    "/parcel/:id",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    verifyParcelOwner,
    controller.deleteParcel,
  );

  return router;
}

module.exports = createParcelQueriesRouter;
