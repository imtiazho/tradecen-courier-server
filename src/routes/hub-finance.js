const express = require("express");

function createHubFinanceRouter(dependencies) {
  const router = express.Router();
  const { managerCache, lateInvoicesCache, hubHandCashCache, hubProfitCache, hubAgingCache, hubEfficiencyCache, depositHistoryCache, mainDashboardCache, verifyFireBaseToken, verifyRoles, verifyAdminToken, verifyHubManagerToken, pendingHubRequests, pendingHubProfitRequests, pendingHubAgingRequests, pendingHubEfficiencyRequests, pendingDepositHistoryRequests, pendingDashboardRequests, ObjectId, connectDB, admin } = dependencies;

  router.get("/hub-hand-cash/:hubName", async (req, res) => {
    try {
      const { hubName } = req.params;
      const cacheKey = `hub_hand_cash_${hubName}`;
      const cachedString = hubHandCashCache.get(cacheKey);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      if (!pendingHubRequests.has(cacheKey)) {
        const fetchPromise = (async () => {
          const { parcelsCollections } = await connectDB();
          const parcels = await parcelsCollections
            .find({
              "serviceCenters.destination": hubName,
              deliveryStatus: "delivered",
              isDepositedToHQ: false,
            })
            .toArray();

          let totalHandCash = 0;
          parcels.forEach((parcel) => {
            const isPayoutPending = [false, "pending"].includes(
              parcel.merchantRevenueStatus,
            );
            if (isPayoutPending) totalHandCash += parcel.codAmount || 0;
            else if (!parcel.deliveryChargeOnlinePaymentStatus)
              totalHandCash += parcel.deliveryCharge || 0;
          });

          const responseData = {
            success: true,
            parcels,
            hubName,
            totalParcelCount: parcels.length,
            totalHandCash,
          };
          const jsonString = JSON.stringify(responseData);
          hubHandCashCache.set(cacheKey, jsonString);
          return jsonString;
        })();
        pendingHubRequests.set(cacheKey, fetchPromise);
      }

      const jsonString = await pendingHubRequests.get(cacheKey);
      pendingHubRequests.delete(cacheKey);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      const { hubName } = req.params;
      pendingHubRequests.delete(`hub_hand_cash_${hubName}`);
      res.status(500).send({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  });

  router.get(
    "/hub-profit-metrics/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    async (req, res) => {
      try {
        const { hubName } = req.params;
        const cacheKey = `hub_profit_metrics_${hubName}`;
        const cachedString = hubProfitCache.get(cacheKey);
        if (cachedString) {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).send(cachedString);
        }

        if (!pendingHubProfitRequests.has(cacheKey)) {
          const fetchPromise = (async () => {
            const { parcelsCollections } = await connectDB();
            const parcels = await parcelsCollections
              .find({
                "serviceCenters.destination": hubName,
                deliveryStatus: "delivered",
                isDepositedToHQ: false,
              })
              .toArray();

            let hqPayableProfit = 0,
              payableParcelCount = 0;
            parcels.forEach((parcel) => {
              if (!parcel.deliveryChargeOnlinePaymentStatus) {
                hqPayableProfit += parcel.deliveryCharge || 0;
                payableParcelCount += 1;
              }
            });

            const responseData = {
              success: true,
              hubName,
              totalParcelCount: payableParcelCount,
              hqPayableProfit,
            };
            const jsonString = JSON.stringify(responseData);
            hubProfitCache.set(cacheKey, jsonString);
            return jsonString;
          })();
          pendingHubProfitRequests.set(cacheKey, fetchPromise);
        }

        const jsonString = await pendingHubProfitRequests.get(cacheKey);
        pendingHubProfitRequests.delete(cacheKey);
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(jsonString);
      } catch (error) {
        const { hubName } = req.params;
        pendingHubProfitRequests.delete(`hub_profit_metrics_${hubName}`);
        console.error("Hub Profit Metrics Error:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
  );

  router.get(
    "/hub-aging-status/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    async (req, res) => {
      try {
        const { hubName } = req.params;
        const cacheKey = `hub_aging_status_${hubName}`;
        const cachedString = hubAgingCache.get(cacheKey);
        if (cachedString) {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).send(cachedString);
        }

        if (!pendingHubAgingRequests.has(cacheKey)) {
          const fetchPromise = (async () => {
            const { parcelsCollections } = await connectDB();
            const activeParcels = await parcelsCollections
              .find({
                $or: [
                  { "serviceCenters.origin": hubName },
                  { "serviceCenters.destination": hubName },
                ],
                deliveryStatus: {
                  $in: [
                    "reached-origin-warehouse",
                    "reached-destination-warehouse",
                  ],
                },
              })
              .toArray();

            let age24H = 0,
              age48H = 0,
              age72HPlus = 0;
            const now = new Date();
            activeParcels.forEach((parcel) => {
              if (parcel.createdAt) {
                const diffInHours =
                  (now - new Date(parcel.createdAt)) / (1000 * 60 * 60);
                if (diffInHours <= 24) age24H++;
                else if (diffInHours <= 48) age48H++;
                else age72HPlus++;
              }
            });

            const jsonString = JSON.stringify({ age24H, age48H, age72HPlus });
            hubAgingCache.set(cacheKey, jsonString);
            return jsonString;
          })();
          pendingHubAgingRequests.set(cacheKey, fetchPromise);
        }

        const jsonString = await pendingHubAgingRequests.get(cacheKey);
        pendingHubAgingRequests.delete(cacheKey);
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(jsonString);
      } catch (error) {
        const { hubName } = req.params;
        pendingHubAgingRequests.delete(`hub_aging_status_${hubName}`);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
  );

  router.get(
    "/hub-efficiency-flow/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    async (req, res) => {
      try {
        const { hubName } = req.params;
        const cacheKey = `hub_efficiency_flow_${hubName}`;
        const cachedString = hubEfficiencyCache.get(cacheKey);
        if (cachedString) {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).send(cachedString);
        }

        if (!pendingHubEfficiencyRequests.has(cacheKey)) {
          const fetchPromise = (async () => {
            const { parcelsCollections } = await connectDB();
            const now = new Date();
            const sevenDayAgoStr = new Date(
              now.getTime() - 7 * 24 * 60 * 60 * 1000,
            ).toISOString();

            const sortingCount = await parcelsCollections.countDocuments({
              createdAt: { $gte: sevenDayAgoStr },
              $or: [
                {
                  "serviceCenters.origin": hubName,
                  deliveryStatus: "reached-origin-warehouse",
                },
                {
                  "serviceCenters.destination": hubName,
                  deliveryStatus: "reached-destination-warehouse",
                },
              ],
            });
            const OutForDeliveryCount = await parcelsCollections.countDocuments({
              "serviceCenters.destination": hubName,
              createdAt: { $gte: sevenDayAgoStr },
              deliveryStatus: "assign-delivery-rider",
            });
            const deliveredCount = await parcelsCollections.countDocuments({
              "serviceCenters.destination": hubName,
              createdAt: { $gte: sevenDayAgoStr },
              deliveryStatus: "delivered",
            });

            const total = sortingCount + OutForDeliveryCount + deliveredCount;
            const responseData = {
              sorting: Math.round((sortingCount / total) * 100) || 0,
              outDelivery: Math.round((OutForDeliveryCount / total) * 100) || 0,
              delivered: Math.round((deliveredCount / total) * 100) || 0,
              totalActive: total,
            };
            const jsonString = JSON.stringify(responseData);
            hubEfficiencyCache.set(cacheKey, jsonString);
            return jsonString;
          })();
          pendingHubEfficiencyRequests.set(cacheKey, fetchPromise);
        }

        const jsonString = await pendingHubEfficiencyRequests.get(cacheKey);
        pendingHubEfficiencyRequests.delete(cacheKey);
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(jsonString);
      } catch (error) {
        const { hubName } = req.params;
        pendingHubEfficiencyRequests.delete(`hub_efficiency_flow_${hubName}`);
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
  );

  router.post("/deposit-HQ/:hubName", async (req, res) => {
    try {
      const { hubName } = req.params;
      const { hqPaymentsCollections, parcelsCollections } = await connectDB();
      const {
        depositedAmount,
        parcelIds,
        paymentMethod,
        transactionDetails,
        submittedBy,
      } = req.body;

      if (!depositedAmount || !parcelIds || parcelIds.length === 0) {
        return res.status(400).send({
          success: false,
          message: "Missing required fields: depositedAmount or parcelIds",
        });
      }

      const depositInvoice = {
        hubName,
        depositedAmount,
        totalParcelsCovered: parcelIds.length,
        parcelIds,
        paymentMethod: paymentMethod || "CASH",
        transactionDetails: transactionDetails || {},
        status: "pending",
        submittedBy: submittedBy || "Hub Manager",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const insertResult = await hqPaymentsCollections.insertOne(depositInvoice);

      if (insertResult.insertedId) {
        const objectIdArray = parcelIds.map((id) => new ObjectId(id));
        await parcelsCollections.updateMany(
          { _id: { $in: objectIdArray } },
          {
            $set: {
              depositRequestStatus: "submitted",
              hqPaymentInvoiceId: insertResult.insertedId,
            },
          },
        );

        depositHistoryCache.bump(hubName);
        hubHandCashCache.del(`hub_hand_cash_${hubName}`);
        managerCache.bump("global");
      }

      res.status(201).send({
        success: true,
        message: "Deposit request submitted to HQ successfully!",
        depositId: insertResult.insertedId,
      });
    } catch (error) {
      console.error("Deposit HQ Error:", error);
      res.status(500).send({
        success: false,
        message: "Internal Server Error",
        error: error.message,
      });
    }
  });

  router.get(
    "/hub-deposit-history",
    verifyFireBaseToken,
    verifyRoles("hub-manager", "admin"),
    async (req, res) => {
      try {
        const { hubName, status } = req.query;
        const owner = hubName || "global";
        const cachedString = depositHistoryCache.get(owner, [status || "all"]);
        if (cachedString) {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).send(cachedString);
        }

        const cacheDedupeKey = `${owner}:${status || "all"}`;
        if (!pendingDepositHistoryRequests.has(cacheDedupeKey)) {
          const fetchPromise = (async () => {
            const { hqPaymentsCollections } = await connectDB();
            const query = {};
            if (hubName) query.hubName = hubName;
            if (status) query.status = status;

            const depositHistory = await hqPaymentsCollections
              .find(query)
              .sort({ createdAt: -1 })
              .toArray();
            const responseData = {
              success: true,
              hubName,
              totalDeposits: depositHistory.length,
              history: depositHistory,
            };
            const jsonString = JSON.stringify(responseData);
            depositHistoryCache.set(owner, [status || "all"], jsonString);
            return jsonString;
          })();
          pendingDepositHistoryRequests.set(cacheDedupeKey, fetchPromise);
        }

        const jsonString =
          await pendingDepositHistoryRequests.get(cacheDedupeKey);
        pendingDepositHistoryRequests.delete(cacheDedupeKey);
        res.setHeader("Content-Type", "application/json");
        res.status(200).send(jsonString);
      } catch (error) {
        const { hubName, status } = req.query;
        pendingDepositHistoryRequests.delete(
          `${hubName || "global"}:${status || "all"}`,
        );
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
  );

  router.patch(
    "/approve-deposit/:id",
    verifyFireBaseToken,
    verifyAdminToken,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { hqPaymentsCollections, parcelsCollections } = await connectDB();
        const invoice = await hqPaymentsCollections.findOne({
          _id: new ObjectId(id),
        });
        const objectParcelIds = invoice.parcelIds.map((pid) => new ObjectId(pid));

        await hqPaymentsCollections.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: "approved", approvedAt: new Date().toISOString() } },
        );
        await parcelsCollections.updateMany(
          { _id: { $in: objectParcelIds } },
          { $set: { isDepositedToHQ: true, depositRequestStatus: "approved" } },
        );

        depositHistoryCache.bump(invoice.hubName);
        depositHistoryCache.bump("global");
        hubHandCashCache.del(`hub_hand_cash_${invoice.hubName}`);
        hubProfitCache.del(`hub_profit_metrics_${invoice.hubName}`);
        lateInvoicesCache.flushAll();
        mainDashboardCache.del("master_admin_main_dashboard");

        res.send({ success: true, message: "Deposit approved successfully!" });
      } catch (error) {
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
  );

  router.get("/master-admin/main-dashboard", async (req, res) => {
    try {
      const cacheKey = "master_admin_main_dashboard";
      const cachedString = mainDashboardCache.get(cacheKey);
      if (cachedString) {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).send(cachedString);
      }

      if (!pendingDashboardRequests.has(cacheKey)) {
        const fetchPromise = (async () => {
          const { parcelsCollections, merchantsCollections, ridersCollections } =
            await connectDB();

          const revenueResult = await parcelsCollections
            .aggregate([
              { $match: { deliveryStatus: "delivered" } },
              { $group: { _id: null, total: { $sum: "$deliveryCharge" } } },
            ])
            .toArray();
          const totalRevenue =
            revenueResult.length > 0 ? revenueResult[0].total : 0;

          const totalParcels = await parcelsCollections.estimatedDocumentCount();
          const totalMerchants =
            await merchantsCollections.estimatedDocumentCount();
          const activeRiders = await ridersCollections.countDocuments({
            currentTasks: { $gt: 0 },
          });
          const pendingPickUpAndDeliveryCount =
            await parcelsCollections.countDocuments({
              deliveryStatus: {
                $in: ["assign-pickup-rider", "assign-delivery-rider"],
              },
            });
          const inTransitAndPickedCount = await parcelsCollections.countDocuments(
            { deliveryStatus: { $in: ["rider-carrying", "in-transit"] } },
          );
          const dispatchCount = await parcelsCollections.countDocuments({
            deliveryStatus: "delivered",
          });

          const transitLiquidityResult = await parcelsCollections
            .aggregate([
              {
                $match: {
                  status: "delivered",
                  revMethod: "COD",
                  isDepositedToHQ: false,
                },
              },
              { $group: { _id: null, totalTransitCash: { $sum: "$codAmount" } } },
            ])
            .toArray();
          const codInTransit =
            transitLiquidityResult.length > 0
              ? transitLiquidityResult[0].totalTransitCash
              : 0;

          const recentParcels = await parcelsCollections
            .find({})
            .sort({ createdAt: -1 })
            .limit(3)
            .project({
              trackingID: 1,
              "senderInfo.name": 1,
              "receiverInfo.name": 1,
              deliveryStatus: 1,
              codAmount: 1,
            })
            .toArray();

          const responseData = {
            success: true,
            metrics: {
              totalRevenue,
              totalParcels,
              totalMerchants,
              activeRiders,
              codInTransit,
            },
            pipeline: {
              pendingPickUpAndDeliveryCount,
              inTransitAndPickedCount,
              dispatchCount,
            },
            recentParcels,
          };
          const jsonString = JSON.stringify(responseData);
          mainDashboardCache.set(cacheKey, jsonString);
          return jsonString;
        })();
        pendingDashboardRequests.set(cacheKey, fetchPromise);
      }

      const jsonString = await pendingDashboardRequests.get(cacheKey);
      pendingDashboardRequests.delete(cacheKey);
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(jsonString);
    } catch (error) {
      pendingDashboardRequests.delete("master_admin_main_dashboard");
      console.error("Main Dashboard Error:", error);
      res.status(500).send({ success: false, message: "Internal Server Error" });
    }
  });

  return router;
}

module.exports = createHubFinanceRouter;
