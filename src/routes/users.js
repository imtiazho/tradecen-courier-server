const express = require("express");

function createUsersRouter(dependencies) {
  const router = express.Router();
  const { usersCache, userCache, userRoleCache, managerCache, verifyFireBaseToken, verifyRoles, verifyOwner, verifyAdminToken, connectDB } = dependencies;
  const verifyHubManagerDirectoryOwner = (req, res, next) => {
    if (req.authorizationRole === "hub-manager") {
      return verifyOwner(req, res, next);
    }
    next();
  };
  verifyHubManagerDirectoryOwner.auditName = "verifyHubManagerDirectoryOwner";

  router.get("/users", verifyFireBaseToken, verifyAdminToken, async (req, res) => {
    try {
      const searchText = req.query.searchText || "";
      const role = req.query.role || "";

      const cachedData = usersCache.get("global", [searchText, role]);
      if (cachedData) {
        return res
          .status(200)
          .send({ success: true, data: cachedData, source: "cache" });
      }

      const { userCollections } = await connectDB();
      const query = {};
      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      if (role) query.role = role;

      const result = await userCollections
        .find(query)
        .sort({ createdAt: -1 })
        .limit(10)
        .project({ email: 1, displayName: 1, role: 1 })
        .toArray();

      usersCache.set("global", [searchText, role], result);
      res.status(200).send({ success: true, data: result, source: "database" });
    } catch (error) {
      res.status(500).send({ message: "Internal Server Error" });
    }
  });

  router.get("/user/:email", verifyFireBaseToken, verifyOwner, async (req, res) => {
    try {
      const email = req.params.email;
      const cacheKey = `user_${email}`;
      const cachedUser = userCache.get(cacheKey);
      if (cachedUser) return res.send(cachedUser);

      const { userCollections } = await connectDB();
      const user = await userCollections.findOne(
        { email: email },
        {
          projection: {
            _id: 0,
            role: 1,
            isOnboarded: 1,
            email: 1,
            displayName: 1,
            photoURL: 1,
            createdAt: 1,
          },
        },
      );
      if (!user) {
        return res
          .status(404)
          .send({ success: false, message: "User not found in database" });
      }
      userCache.set(cacheKey, user);
      res.send(user);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  });

  router.get(
    "/user/:email/role",
    verifyFireBaseToken,
    verifyOwner,
    async (req, res) => {
      try {
        const cacheKey = `user_role_${req.params.email}`;
        const cachedRole = userRoleCache.get(cacheKey);
        if (cachedRole) return res.send({ role: cachedRole });

        const { userCollections } = await connectDB();
        const user = await userCollections.findOne({ email: req.params.email });
        if (!user) {
          return res
            .status(404)
            .send({ success: false, message: "User not found in database" });
        }
        userRoleCache.set(cacheKey, user.role);
        res.send({ role: user.role });
      } catch (error) {
        console.error("Failed to load user role");
        res.status(500).send({ success: false, error: "Internal Server Error" });
      }
    },
  );

  router.patch("/users/update/:email", verifyFireBaseToken, verifyOwner, async (req, res) => {
    try {
      const { userCollections } = await connectDB();
      const email = req.params.email;
      const profileUpdates = { ...req.body };
      delete profileUpdates.role;
      delete profileUpdates.isOnboarded;
      delete profileUpdates.email;
      const result = await userCollections.updateOne(
        { email },
        { $set: profileUpdates },
      );

      userCache.del(`user_${email}`);
      userRoleCache.del(`user_role_${email}`);
      usersCache.bump("global");

      res.send(result);
    } catch (error) {
      res.status(500).send({ success: false, error: "Internal Server Error" });
    }
  });

  router.post("/users", verifyFireBaseToken, verifyOwner, async (req, res) => {
    try {
      const { userCollections } = await connectDB();
      const profile = { ...req.body };
      delete profile.role;
      delete profile.isOnboarded;
      const user = { ...profile, email: req.decoded_email, role: "user" };
      const isExist = await userCollections.findOne({ email: user.email });
      if (isExist) return res.send({ message: "User already exists" });

      const result = await userCollections.insertOne(user);
      usersCache.bump("global");
      res.send(result);
    } catch (err) {
      res.status(500).send({ error: err.message });
    }
  });

  router.patch("/users/verify-status/:email", verifyFireBaseToken, verifyOwner, async (req, res) => {
    try {
      const { userCollections } = await connectDB();
      const email = req.params.email;
      const result = await userCollections.updateOne(
        { email },
        { $set: { isOnboarded: true } },
      );

      userCache.del(`user_${email}`);
      userRoleCache.del(`user_role_${email}`);
      usersCache.bump("global");

      res.send(result);
    } catch (error) {
      res.status(500).send({ error: "Internal Server Error" });
    }
  });

  router.patch(
    "/users/make-hub-manager",
    verifyFireBaseToken,
    verifyAdminToken,
    async (req, res) => {
      try {
        const { userCollections, hubManagersCollection } = await connectDB();
        const data = req.body;
        const { email, region, district, hubName } = data;

        const userFilter = { email: email };
        const updateRole = { $set: { role: "hub-manager" } };
        const updateResult = await userCollections.updateOne(
          userFilter,
          updateRole,
        );

        if (updateResult.modifiedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "User not found or role already updated",
          });
        }

        const userProfile = await userCollections.findOne({ email: email });
        const hubManagerDoc = {
          userId: userProfile._id,
          name: userProfile.displayName,
          email: email,
          photoURL: userProfile.photoURL || "",
          region,
          district,
          hubName,
          assignedAt: new Date(),
          status: "active",
        };
        const insertResult = await hubManagersCollection.insertOne(hubManagerDoc);

        if (insertResult.insertedId) {
          userCache.del(`user_${email}`);
          userRoleCache.del(`user_role_${email}`);
          usersCache.bump("global");
          managerCache.bump("global");

          res.send({
            success: true,
            message: "User promoted and added to Hub Managers collection",
          });
        }
      } catch (error) {
        console.error("Failed to add hub manager");
        res
          .status(500)
          .send({ success: false, message: "Internal Server Error" });
      }
    },
  );

  router.get(
    "/users/hub-managers",
    verifyFireBaseToken,
    verifyRoles("admin", "hub-manager"),
    verifyHubManagerDirectoryOwner,
    async (req, res) => {
    try {
      const { region, district, email } = req.query;
      if (req.authorizationRole === "hub-manager") {
        const { hubManagersCollection } = await connectDB();
        const manager = await hubManagersCollection.findOne({
          email: req.decoded_email,
        });
        if (!manager || typeof manager.hubName !== "string" || !manager.hubName.trim()) {
          return res.status(403).send({
            success: false,
            message: "Hub Manager assignment not found",
          });
        }
        return res.status(200).send(email ? manager : [manager]);
      }

      const cachedData = managerCache.get("global", [
        email || "all",
        region || "all",
        district || "all",
      ]);
      if (cachedData) return res.status(200).send(cachedData);

      let query = {};
      if (email) query.email = email;
      if (region) query.region = region;
      if (district) query.district = district;

      const { hubManagersCollection } = await connectDB();
      const result = await hubManagersCollection.find(query).toArray();
      const finalData = email ? result[0] || null : result;

      managerCache.set(
        "global",
        [email || "all", region || "all", district || "all"],
        finalData,
      );
      res.status(200).send(finalData);
    } catch (error) {
      console.error("Failed to fetch hub managers");
      res.status(500).send({ message: "Internal Server Error" });
    }
    },
  );

  return router;
}

module.exports = createUsersRouter;
