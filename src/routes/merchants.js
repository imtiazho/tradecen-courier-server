const express = require("express");

function createMerchantsRouter(dependencies) {
  const router = express.Router();
  const { usersCache, userCache, userRoleCache, allMerchantsCache, merchantsAreaWiseCache, targetedMerchantCache, verifyFireBaseToken, verifyOwner, verifyAdminToken, verifyMerchantToken, verifyHubManagerToken, verifyAssignedHub, connectDB } = dependencies;

  router.get(
    "/all-merchants",
    verifyFireBaseToken,
    verifyAdminToken,
    async (req, res) => {
      try {
        const cacheKey = "allMerchants";
        const cacheData = allMerchantsCache.get(cacheKey);
        if (cacheData) return res.send({ success: true, cacheData });

        const { merchantsCollections } = await connectDB();
        const result = await merchantsCollections.find({}).toArray();
        allMerchantsCache.set(cacheKey, result);
        res.send(result);
      } catch (error) {
        res.status(500).send({ success: false, error: "Internal Server Error" });
      }
    },
  );

  router.get(
    "/area-merchant/:hubName",
    verifyFireBaseToken,
    verifyHubManagerToken,
    verifyAssignedHub,
    async (req, res) => {
      try {
        const { hubName } = req.params;
        const cacheKey = `area_merchant_${hubName}`;
        const cachedMerchants = merchantsAreaWiseCache.get(cacheKey);
        if (cachedMerchants) return res.send(cachedMerchants);

        const { merchantsCollections } = await connectDB();
        const result = await merchantsCollections
          .find({ area: hubName })
          .toArray();
        merchantsAreaWiseCache.set(cacheKey, result);
        res.send(result);
      } catch (error) {
        res.status(500).send({ success: false, error: "Internal Server Error" });
      }
    },
  );

  router.post("/merchants", verifyFireBaseToken, verifyOwner, async (req, res) => {
    try {
      const { merchantsCollections, userCollections } = await connectDB();
      const merchantProfile = { ...req.body };
      delete merchantProfile.role;
      const newMerchant = { ...merchantProfile, email: req.decoded_email, role: "merchant" };
      const isExist = await merchantsCollections.findOne({
        email: newMerchant.email,
      });
      if (isExist)
        return res.send({ message: "This email already used for Merchant!" });

      const result = await merchantsCollections.insertOne(newMerchant);
      await userCollections.updateOne(
        { email: newMerchant.email },
        { $set: { role: "merchant" } },
      );

      userCache.del(`user_${newMerchant.email}`);
      userRoleCache.del(`user_role_${newMerchant.email}`);
      usersCache.bump("global");
      allMerchantsCache.del("allMerchants");
      if (newMerchant.area)
        merchantsAreaWiseCache.del(`area_merchant_${newMerchant.area}`);

      res.send(result);
    } catch (error) {
      res.status(500).send({ error: "Internal Server Error" });
    }
  });

  router.get(
    "/merchant/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    async (req, res) => {
      try {
        const email = req.params.email;
        const cacheKey = `merchant_${email}`;
        const cachedData = targetedMerchantCache.get(cacheKey);
        if (cachedData) return res.send(cachedData);

        const { merchantsCollections } = await connectDB();
        const merchant = await merchantsCollections.findOne({ email: email });
        if (!merchant) {
          return res
            .status(404)
            .send({ success: false, message: "User not found in database" });
        }

        const responseData = {
          success: true,
          role: merchant.role,
          email: merchant.email,
          ...merchant,
        };
        targetedMerchantCache.set(cacheKey, responseData);
        res.send(responseData);
      } catch (error) {
        res.status(500).send({ success: false, error: "Internal Server Error" });
      }
    },
  );

  router.patch(
    "/merchant-update/:email",
    verifyFireBaseToken,
    verifyMerchantToken,
    verifyOwner,
    async (req, res) => {
      try {
        const { merchantsCollections } = await connectDB();
        const email = req.params.email;
        const updatedMerchantInfo = { ...req.body };
        delete updatedMerchantInfo.role;
        delete updatedMerchantInfo.email;
        const result = await merchantsCollections.updateOne(
          { email },
          { $set: updatedMerchantInfo },
        );

        if (result.modifiedCount > 0) {
          targetedMerchantCache.del(`merchant_${email}`);
          userCache.del(`user_${email}`);
          allMerchantsCache.del("allMerchants");
          if (updatedMerchantInfo.area)
            merchantsAreaWiseCache.del(
              `area_merchant_${updatedMerchantInfo.area}`,
            );

          res.send({ success: true, message: "Merchant profile edited done" });
        } else {
          res.status(404).send({ success: false, message: "Merchant not found" });
        }
      } catch (error) {
        res.status(500).send({ success: false, error: "Internal Server Error" });
      }
    },
  );

  return router;
}

module.exports = createMerchantsRouter;
