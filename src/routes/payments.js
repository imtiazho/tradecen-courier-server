const express = require("express");

function createPaymentsRouter(dependencies) {
  const router = express.Router();
  const { revenueStatsCache, mainDashboardCache, stripe, invalidateParcelStatusChange, ObjectId, connectDB, withTransaction } = dependencies;

  router.get("/", (req, res) => res.send("🚀 TradeCen Server Running"));

  router.post("/payment-checkout", async (req, res) => {
    try {
      const paymentInfo = req.body || {};
      if (!/^[a-f\d]{24}$/i.test(paymentInfo.parcelId || "")) {
        return res.status(400).send({ success: false, message: "Invalid parcel" });
      }
      const { parcelsCollections } = await connectDB();
      const parcel = await parcelsCollections.findOne({ _id: new ObjectId(paymentInfo.parcelId) });
      if (!parcel) return res.status(404).send({ success: false, message: "Parcel not found" });
      if (parcel.deliveryChargeStatus === "paid") {
        return res.status(400).send({ success: false, message: "Delivery charge already paid" });
      }
      const amount = Math.round(Number(parcel.deliveryCharge) * 100);
      if (!Number.isSafeInteger(amount) || amount <= 0 || !parcel.senderInfo?.email) {
        return res.status(400).send({ success: false, message: "Invalid parcel payment details" });
      }
      const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "USD",
            unit_amount: amount,
            product_data: {
              name: `Payment checkout for ${parcel.parcelName}`,
            },
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      metadata: {
        parcelId: paymentInfo.parcelId,
        percelName: parcel.parcelName,
        trackingID: parcel.trackingID,
      },
      customer_email: parcel.senderInfo.email,
      success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    } catch (error) {
      res.status(500).send({ success: false, message: "Unable to create payment session" });
    }
  });

  router.patch("/verify-payment", async (req, res) => {
    try {
      const sessionId = req.query.session_id;
      if (typeof sessionId !== "string" || !sessionId) {
        return res.status(400).send({ success: false, message: "Invalid payment session" });
      }
      const { paymentCollections, parcelsCollections } = await connectDB();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const transactionId = session.payment_intent;
      const metadata = session.metadata || {};
      if (!transactionId || !/^[a-f\d]{24}$/i.test(metadata.parcelId || "")) {
        return res.status(400).send({ success: false, message: "Invalid payment session" });
      }

      const outcome = await withTransaction(async (dbSession) => {
        const paymentExisted = await paymentCollections.findOne(
          { transactionId }, { session: dbSession },
        );
        if (paymentExisted) return { type: "existing", payment: paymentExisted };
        if (session.payment_status !== "paid" || session.mode !== "payment" || session.currency !== "usd") {
          return { type: "unpaid" };
        }

        const parcelId = new ObjectId(metadata.parcelId);
        const parcel = await parcelsCollections.findOne({ _id: parcelId }, { session: dbSession });
        const expectedAmount = Math.round(Number(parcel?.deliveryCharge) * 100);
        if (!parcel || parcel.deliveryChargeStatus === "paid" ||
          !Number.isSafeInteger(expectedAmount) || expectedAmount <= 0 ||
          session.amount_total !== expectedAmount ||
          session.customer_email !== parcel.senderInfo?.email ||
          metadata.trackingID !== parcel.trackingID) {
          return { type: "invalid" };
        }

        const trackingID = parcel.trackingID;
        const paymentHistory = {
          product: parcel.parcelName,
          amount: session.amount_total / 100,
          customer_email: session.customer_email,
          transactionId,
          trackingID,
          paidAt: new Date(),
        };
        const update = await parcelsCollections.updateOne(
          { _id: parcelId, deliveryChargeStatus: { $ne: "paid" } },
          { $set: { deliveryChargeStatus: "paid", deliveryChargeOnlinePaymentStatus: true } },
          { session: dbSession },
        );
        if (update.matchedCount === 0) return { type: "invalid" };
        await paymentCollections.insertOne(paymentHistory, { session: dbSession });
        return { type: "created", payment: paymentHistory, parcel };
      });

      if (outcome.type === "existing") {
        return res.send({
          message: "Already exist",
          ...outcome.payment,
          transactionId,
          trackingID: outcome.payment.trackingID,
        });
      }
      if (outcome.type === "unpaid") return res.send({ success: false });
      if (outcome.type !== "created") {
        return res.status(400).send({ success: false, message: "Payment does not match parcel" });
      }

      invalidateParcelStatusChange({
        trackingID: outcome.parcel.trackingID,
        senderEmail: outcome.parcel.senderInfo?.email,
        originHub: outcome.parcel.serviceCenters?.origin,
        destinationHub: outcome.parcel.serviceCenters?.destination,
        parcelId: metadata.parcelId,
      });
      revenueStatsCache.bump(outcome.parcel.senderInfo.email);
      mainDashboardCache.del("master_admin_main_dashboard");
      return res.send({ success: true, ...outcome.payment, transactionId, trackingID: outcome.parcel.trackingID });
    } catch (error) {
      res.status(500).send({ success: false, message: "Unable to verify payment" });
    }
  });

  return router;
}

module.exports = createPaymentsRouter;
