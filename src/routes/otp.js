const express = require("express");
const { randomInt } = require("node:crypto");

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_SEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function createOtpRouter(dependencies) {
  const router = express.Router();
  const { admin, transporter } = dependencies;

  const validEmail = (email) =>
    typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  router.post("/send-otp", async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).send({ error: "Email is required" });
    if (!validEmail(email)) return res.status(400).send({ error: "Valid email is required" });

    try {
      const firestore = admin.firestore();
      const otpDoc = firestore.collection("otps").doc(email);
      const otp = randomInt(100000, 1000000);
      const now = Date.now();
      const allowed = await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(otpDoc);
        const stored = snapshot.exists ? snapshot.data() : null;
        if (stored?.lastSentAt && now - stored.lastSentAt < OTP_SEND_COOLDOWN_MS) {
          return false;
        }
        transaction.set(otpDoc, {
          otp,
          expiresAt: now + OTP_TTL_MS,
          lastSentAt: now,
          attemptCount: 0,
        });
        return true;
      });
      if (!allowed) {
        return res.status(429).send({ error: "Please wait before requesting another OTP" });
      }

      await transporter.sendMail({
        from: `"TradeCen" <${process.env.EMAIL}>`,
        to: email,
        subject: "Your OTP Code",
        text: `Your OTP is ${otp}. It will expire in 5 minutes.`,
      });
      res.send({ success: true, message: "OTP sent successfully" });
    } catch (error) {
      console.error("Error sending OTP");
      res.status(500).send({ error: "Unable to send OTP" });
    }
  });

  router.post("/verify-otp", async (req, res) => {
    const { email, otp } = req.body || {};
    if (!validEmail(email) || !/^\d{6}$/.test(String(otp ?? ""))) {
      return res.status(400).send({ error: "Invalid OTP code" });
    }

    try {
      const firestore = admin.firestore();
      const otpDoc = firestore.collection("otps").doc(email);
      const result = await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(otpDoc);
        if (!snapshot.exists) return "missing";

        const stored = snapshot.data();
        const now = Date.now();
        if (now > stored.expiresAt) return "expired";
        if (stored.verifiedAt) return "used";
        if ((stored.attemptCount || 0) >= MAX_OTP_ATTEMPTS) return "locked";

        if (Number(otp) !== stored.otp) {
          const attempts = (stored.attemptCount || 0) + 1;
          transaction.set(otpDoc, { attemptCount: attempts }, { merge: true });
          return attempts >= MAX_OTP_ATTEMPTS ? "locked" : "invalid";
        }

        transaction.set(otpDoc, { verifiedAt: now }, { merge: true });
        return "verified";
      });

      if (result === "missing") return res.status(404).send({ error: "OTP not found. Please resend." });
      if (result === "expired") return res.status(400).send({ error: "OTP has expired" });
      if (result === "locked") return res.status(429).send({ error: "Too many invalid OTP attempts" });
      if (result !== "verified") return res.status(400).send({ error: "Invalid OTP code" });
      res.send({ success: true, message: "OTP verified" });
    } catch (error) {
      res.status(500).send({ error: "Unable to verify OTP" });
    }
  });

  router.post("/reset-password", async (req, res) => {
    const { email, newPassword } = req.body || {};
    if (!validEmail(email) || typeof newPassword !== "string" || !newPassword) {
      return res.status(400).send({ error: "Email and new password are required" });
    }

    const firestore = admin.firestore();
    const otpDoc = firestore.collection("otps").doc(email);
    let passwordUpdated = false;
    try {
      const claimed = await firestore.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(otpDoc);
        if (!snapshot.exists) return "missing";
        const stored = snapshot.data();
        if (Date.now() > stored.expiresAt) return "expired";
        if (!stored.verifiedAt || stored.resetStartedAt) return "unverified";
        transaction.set(otpDoc, { resetStartedAt: Date.now() }, { merge: true });
        return "claimed";
      });

      if (claimed === "expired") return res.status(400).send({ error: "OTP has expired" });
      if (claimed !== "claimed") return res.status(400).send({ error: "OTP verification required" });

      const user = await admin.auth().getUserByEmail(email);
      await admin.auth().updateUser(user.uid, { password: newPassword });
      passwordUpdated = true;
      await otpDoc.delete();
      res.send({ success: true, message: "Password updated successfully" });
    } catch (error) {
      if (passwordUpdated) {
        return res.send({ success: true, message: "Password updated successfully" });
      }
      try {
        await firestore.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(otpDoc);
          if (snapshot.exists) transaction.set(otpDoc, { resetStartedAt: null }, { merge: true });
        });
      } catch (releaseError) { /* OTP still expires on its original deadline. */ }
      res.status(500).send({ error: "Unable to reset password" });
    }
  });

  return router;
}

module.exports = createOtpRouter;
