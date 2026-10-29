const express = require("express");

function createPayoutsRouter(dependencies) {
  const router = express.Router();
  const { merchantParcelsCache, allMerchantsCache, payoutSummaryCache, allPayoutsCache, merchantUnpaidCache, parcelsStatusWiseCache, revenueStatsCache, ObjectId, connectDB, admin } = dependencies;

  router.get("/payment-payout-summary/:email", async (req, res) => {
    try {
      const email = req.params.email;
      const cacheKey = `payout_summary_${email.toLowerCase()}`;
      const cachedData = payoutSummaryCache.get(cacheKey);
      if (cachedData) return res.send(cachedData);

      const { parcelsCollections, payoutsCollections } = await connectDB();
      const deliveredParcels = await parcelsCollections
        .find({
          "senderInfo.email": email,
          deliveryStatus: "delivered",
          merchantRevenueStatus: false,
        })
        .toArray();

      let availableBalance = 0;
      deliveredParcels.forEach((parcel) => {
        const cod = parcel.codAmount;
        const deliveryCharge = parcel.deliveryCharge;
        parcel.deliveryChargeStatus === "paid"
          ? (availableBalance += cod)
          : (availableBalance += cod - deliveryCharge);
      });

      const completedPayouts = await payoutsCollections
        .find({ email: email, payoutStatus: "completed" })
        .toArray();
      const totalWithdrawn = completedPayouts.reduce(
        (sum, p) => sum + p.amount,
        0,
      );

      const pendingPayouts = await payoutsCollections
        .find({ email: email, payoutStatus: "pending" })
        .toArray();
      const totalPending = pendingPayouts.reduce(
        (sum, p) => sum + (Number(p.amount) || 0),
        0,
      );

      const recentTransactions = await payoutsCollections
        .find({ email: email })
        .limit(5)
        .sort({ requestedAt: -1 })
        .toArray();
      const pendingTransactions = await payoutsCollections
        .find({ email: email, payoutStatus: "pending" })
        .sort({ requestedAt: -1 })
        .toArray();

      const responseData = {
        success: true,
        totalRevenue: availableBalance,
        totalWithdrawn,
        totalPending,
        availableBalance,
        deliveredParcels,
        recentTransactions,
        pendingTransactions,
        completedPayouts,
      };
      payoutSummaryCache.set(cacheKey, responseData);
      res.send(responseData);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  });

  router.post("/request-payout", async (req, res) => {
    try {
      const { parcelsCollections, paymentCollections, payoutsCollections } =
        await connectDB();
      const { email, withdrawAmount, paymentMethod } = req.body;
      if (!email || !withdrawAmount || withdrawAmount <= 0) {
        return res
          .status(400)
          .send({ success: false, message: "Invalid request data" });
      }

      const deliveredParcels = await parcelsCollections
        .find({
          "senderInfo.email": email,
          deliveryStatus: "delivered",
          merchantRevenueStatus: false,
        })
        .toArray();

      let totalRevenue = 0;
      deliveredParcels.forEach((parcel) => {
        const cod = parcel.codAmount;
        const deliveryCharge = parcel.deliveryCharge;
        parcel.deliveryChargeStatus === "paid"
          ? (totalRevenue += cod)
          : (totalRevenue += cod - deliveryCharge);
      });

      if (withdrawAmount > totalRevenue) {
        return res.status(400).send({
          success: false,
          message:
            "Insufficient balance! You cannot withdraw more than your available balance.",
        });
      }

      const baseParcelsInfo = deliveredParcels.map((parcel) => ({
        parcelId: parcel._id,
        codAmount: parcel.codAmount,
        deliveryCharge: parcel.deliveryCharge,
        merchantName: parcel.senderInfo?.name || "N/A",
      }));

      const newPayoutRequest = {
        email,
        amount: Number(withdrawAmount),
        payoutStatus: "pending",
        method: paymentMethod?.type || "bKash",
        accountNumber: paymentMethod?.number || "N/A",
        requestedAt: new Date().toISOString(),
        trxID: null,
        parcelsBreakdown: baseParcelsInfo,
      };
      const result = await payoutsCollections.insertOne(newPayoutRequest);

      if (result.insertedId) {
        const parcelIds = baseParcelsInfo.map((p) => p.parcelId);
        await parcelsCollections.updateMany(
          { _id: { $in: parcelIds } },
          { $set: { merchantRevenueStatus: "pending" } },
        );

        payoutSummaryCache.del(`payout_summary_${email.toLowerCase()}`);
        allPayoutsCache.del("all_pending_payouts");
        merchantUnpaidCache.del(`unpaid_parcels_${email}`);
        merchantParcelsCache.bump(email);
        parcelsStatusWiseCache.bump(email);
        revenueStatsCache.bump(email);

        res.send({
          success: true,
          message:
            "Payout request submitted successfully. Waiting for admin approval.",
          insertedId: result.insertedId,
        });
      } else {
        res
          .status(500)
          .send({ success: false, message: "Failed to create payout request" });
      }
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  });

  router.patch("/approve-payout/:id", async (req, res) => {
    try {
      const { payoutsCollections, parcelsCollections } = await connectDB();
      const payoutId = req.params.id;
      const { status, trxID } = req.body;

      const payoutRequest = await payoutsCollections.findOne({
        _id: new ObjectId(payoutId),
      });
      if (!payoutRequest) {
        return res
          .status(404)
          .send({ success: false, message: "Payout request not found" });
      }

      if (status === "Completed") {
        if (!trxID) {
          return res.status(400).send({
            success: false,
            message: "Transaction ID (TrxID) is required for completed payouts.",
          });
        }
        await payoutsCollections.updateOne(
          { _id: new ObjectId(payoutId) },
          {
            $set: {
              payoutStatus: "completed",
              trxID,
              approvedAt: new Date().toISOString(),
            },
          },
        );
        const parcelIds = payoutRequest.parcelsBreakdown.map(
          (p) => new ObjectId(p.parcelId),
        );
        await parcelsCollections.updateMany(
          { _id: { $in: parcelIds } },
          { $set: { merchantRevenueStatus: true, deliveryChargeStatus: "paid" } },
        );

        allPayoutsCache.del("all_pending_payouts");
        payoutSummaryCache.del(
          `payout_summary_${payoutRequest.email.toLowerCase()}`,
        );
        merchantParcelsCache.bump(payoutRequest.email);
        parcelsStatusWiseCache.bump(payoutRequest.email);
        allMerchantsCache.del("allMerchants");
        merchantUnpaidCache.del(`unpaid_parcels_${payoutRequest.email}`);

        return res.send({
          success: true,
          message: "Payout approved and completed successfully!",
        });
      }

      if (status === "Rejected") {
        await payoutsCollections.updateOne(
          { _id: new ObjectId(payoutId) },
          {
            $set: {
              payoutStatus: "rejected",
              rejectedAt: new Date().toISOString(),
            },
          },
        );
        const parcelIds = payoutRequest.parcelsBreakdown.map(
          (p) => new ObjectId(p.parcelId),
        );
        await parcelsCollections.updateMany(
          { _id: { $in: parcelIds } },
          { $set: { merchantRevenueStatus: null } },
        );

        allPayoutsCache.del("all_pending_payouts");
        payoutSummaryCache.del(
          `payout_summary_${payoutRequest.email.toLowerCase()}`,
        );
        merchantParcelsCache.bump(payoutRequest.email);
        parcelsStatusWiseCache.bump(payoutRequest.email);
        allMerchantsCache.del("allMerchants");
        merchantUnpaidCache.del(`unpaid_parcels_${payoutRequest.email}`);

        return res.send({
          success: true,
          message:
            "Payout request rejected. Parcels released back to merchant balance.",
        });
      }
    } catch (error) {
      console.error("Approval API Error:", error);
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  });

  router.get("/all-payouts", async (req, res) => {
    try {
      const cacheKey = "all_pending_payouts";
      const cachedData = allPayoutsCache.get(cacheKey);
      if (cachedData) return res.send(cachedData);

      const { payoutsCollections } = await connectDB();
      const result = await payoutsCollections
        .find({ payoutStatus: "pending" })
        .sort({ requestedAt: -1 })
        .toArray();
      const responseData = { success: true, data: result };
      allPayoutsCache.set(cacheKey, responseData);
      res.send(responseData);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  });

  return router;
}

module.exports = createPayoutsRouter;
