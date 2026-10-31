const express = require("express");

function createOtpRouter(dependencies) {
  const router = express.Router();
  const { admin, transporter } = dependencies;

  router.post("/send-otp", async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).send({ error: "Email is required" });
      try {
        const otp = Math.floor(100000 + Math.random() * 900000);
        await admin
          .firestore()
          .collection("otps")
          .doc(email)
          .set({ otp, expiresAt: Date.now() + 5 * 60 * 1000 });
        await transporter.sendMail({
          from: `"TradeCen" <${process.env.EMAIL}>`,
          to: email,
          subject: "Your OTP Code",
          text: `Your OTP is ${otp}. It will expire in 5 minutes.`,
        });
        res.send({ success: true, message: "OTP sent successfully" });
      } catch (error) {
        console.error("Error sending OTP:", error);
        res.status(500).send({ error: error.message });
      }
    });

  router.post("/verify-otp", async (req, res) => {
      const { email, otp } = req.body;
      try {
        const otpDoc = admin.firestore().collection("otps").doc(email);
        const doc = await otpDoc.get();
        if (!doc.exists)
          return res.status(404).send({ error: "OTP not found. Please resend." });

        const stored = doc.data();
        if (Date.now() > stored.expiresAt)
          return res.status(400).send({ error: "OTP has expired" });
        if (parseInt(otp) !== stored.otp)
          return res.status(400).send({ error: "Invalid OTP code" });

        await otpDoc.set({ verifiedAt: Date.now() }, { merge: true });
        res.send({ success: true, message: "OTP verified" });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

  router.post("/reset-password", async (req, res) => {
      const { email, newPassword } = req.body;
      try {
        const otpDoc = admin.firestore().collection("otps").doc(email);
        const otpSnapshot = await otpDoc.get();
        if (!otpSnapshot.exists) {
          return res.status(400).send({ error: "OTP verification required" });
        }

        const storedOtp = otpSnapshot.data();
        if (!storedOtp.verifiedAt) {
          return res.status(400).send({ error: "OTP verification required" });
        }
        if (Date.now() > storedOtp.expiresAt) {
          return res.status(400).send({ error: "OTP has expired" });
        }

        const user = await admin.auth().getUserByEmail(email);
        await admin.auth().updateUser(user.uid, { password: newPassword });
        await otpDoc.delete();
        res.send({ success: true, message: "Password updated successfully" });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

  return router;
}

module.exports = createOtpRouter;
