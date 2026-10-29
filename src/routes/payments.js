const express = require("express");

function createPaymentsRouter(dependencies) {
  const router = express.Router();
  const { revenueStatsCache, mainDashboardCache, stripe, invalidateParcelStatusChange, ObjectId, connectDB } = dependencies;

  router.get("/", (req, res) => res.send("🚀 TradeCen Server Running"));

  router.post("/payment-checkout", async (req, res) => {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.deliveryCharge) * 100;
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "USD",
            unit_amount: amount,
            product_data: {
              name: `Payment checkout for ${paymentInfo.parcelName}`,
            },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        parcelId: paymentInfo.parcelId,
        percelName: paymentInfo.percelName,
        trackingID: paymentInfo.trackingID,
      },
      customer_email: paymentInfo.senderEmail,
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    });
    res.send({ url: session.url });
  });

  router.patch("/verify-payment", async (req, res) => {
    const { paymentCollections, parcelsCollections } = await connectDB();
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    const transactionId = session.payment_intent;

    const paymentExisted = await paymentCollections.findOne({ transactionId });
    if (paymentExisted) {
      return res.send({
        message: "Already exist",
        ...paymentExisted,
        transactionId,
        trackingID: paymentExisted.trackingID,
      });
    }

    const trackingID = session.metadata.trackingID;
    if (session.payment_status === "paid") {
      const parcel = await parcelsCollections.findOneAndUpdate(
        { _id: new ObjectId(session.metadata.parcelId) },
        {
          $set: {
            deliveryChargeStatus: "paid",
            deliveryChargeOnlinePaymentStatus: true,
          },
        },
        { returnDocument: "after" },
      );

      const paymentHistory = {
        product: session.metadata.percelName,
        amount: session.amount_total / 100,
        customer_email: session.customer_email,
        transactionId,
        trackingID,
        paidAt: new Date(),
      };
      await paymentCollections.insertOne(paymentHistory);

      invalidateParcelStatusChange({
        trackingID,
        senderEmail: parcel?.senderInfo?.email,
        originHub: parcel?.serviceCenters?.origin,
        destinationHub: parcel?.serviceCenters?.destination,
        parcelId: session.metadata.parcelId,
      });
      if (parcel?.senderInfo?.email)
        revenueStatsCache.bump(parcel.senderInfo.email);
      mainDashboardCache.del("master_admin_main_dashboard");

      return res.send({
        success: true,
        ...paymentHistory,
        transactionId,
        trackingID,
      });
    }
    res.send({ success: false });
  });

  return router;
}

module.exports = createPaymentsRouter;
