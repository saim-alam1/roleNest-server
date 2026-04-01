const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// To Fix DNS Issue
const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tk9oapf.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const serviceAccount = require("./firebase-admin-service-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function run() {
  try {
    const apartmentsCollection = client.db("roleNest").collection("apartments");
    const applicationsCollection = client
      .db("roleNest")
      .collection("applications");
    const usersCollection = client.db("roleNest").collection("users");
    const couponsCollection = client.db("roleNest").collection("coupons");
    const announcementsCollection = client
      .db("roleNest")
      .collection("announcement");
    const paymentHistoryCollection = client
      .db("roleNest")
      .collection("paymentHistory");

    // Custom Middlewares

    // Verify Firebase Access Token
    const verifyJWT = async (req, res, next) => {
      const authHeader = req.headers?.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized Access" });
      }

      const token = authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).send({ message: "Unauthorized Access" });
      }

      // Verifying The Token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
    };

    // Verify Role Admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;

      const user = await usersCollection.findOne({
        userEmail: email,
      });

      if (!user || user.role !== "admin") {
        return res.status(403).send({
          message: "Forbidden Access",
        });
      }

      next();
    };

    // Verify Role Member
    const verifyMember = async (req, res, next) => {
      const email = req.decoded.email;

      const user = await usersCollection.findOne({
        userEmail: email,
      });

      if (!user || user.role !== "member") {
        return res.status(403).send({
          message: "Forbidden Access",
        });
      }

      next();
    };

    // Get all apartment data
    app.get("/apartments", async (req, res) => {
      const page = parseInt(req.query.page) || 0;
      const limit = parseInt(req.query.limit) || 6;
      const result = await apartmentsCollection
        .find()
        .skip(page * limit)
        .limit(limit)
        .toArray();
      res.send(result);
    });

    // Posting User Agreements In Resident's Collection (VerifyJWT)
    app.post("/resident", async (req, res) => {
      const userReq = req.body;

      const alreadyExists = await applicationsCollection.findOne({
        userEmail: userReq.userEmail,
      });

      if (alreadyExists) {
        return res.send({ message: "You're already in the queue" });
      }

      const result = await applicationsCollection.insertOne({
        ...userReq,
        status: "pending",
        requestedAt: new Date(),
      });
      res.send(result);
    });

    // Loading User Role (VerifyJWT)
    app.get("/user/:email/role", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ userEmail: email });
      res.send(result?.role);
    });

    // Get All Agreement Requests (VerifyJWT, VerifyAdmin)
    app.get("/agreement-requests", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await applicationsCollection
        .find({ status: "pending" })
        .toArray();
      res.send(result);
    });

    // Get All Agreement Requests (VerifyJWT)
    app.get(
      "/approved-agreement/:email",
      verifyJWT,
      verifyMember,
      async (req, res) => {
        try {
          const email = req.params.email;

          if (req.decoded.email !== email) {
            return res.status(403).send({ message: "Forbidden Access" });
          }

          const result = await applicationsCollection.findOne({
            userEmail: email,
          });
          res.send(result);
        } catch (error) {
          res
            .status(500)
            .json({ message: "Server error", error: error.message });
        }
      },
    );

    // Accept Agreement By Email (VerifyJWT, VerifyAdmin)
    app.patch("/accept-agreement/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const updateResidentStatus =
          await applicationsCollection.findOneAndUpdate(
            { userEmail: email },
            { $set: { status: "checked", agreementAcceptedDate: new Date() } },
            { returnDocument: "after" },
          );

        const updateUsersRole = await usersCollection.findOneAndUpdate(
          { userEmail: email },
          { $set: { role: "member" } },
          { returnDocument: "after" },
        );
        res.status(200).json({ message: "Agreement accepted successfully" });
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    // Reject Agreement By Email (VerifyJWT, VerifyAdmin)
    app.patch("/reject-agreement/:email", async (req, res) => {
      try {
        const email = req.params.email;
        await applicationsCollection.findOneAndUpdate(
          { userEmail: email },
          { $set: { status: "checked" } },
          { returnDocument: "after" },
        );
        res.status(200).json({ message: "Agreement Rejected successfully" });
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    // Create a payment intent
    app.post("/create-payment-intent", async (req, res) => {
      const amountInPoisha = req.body.amountInPoisha;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInPoisha, // Amount in poisha
          currency: "bdt",
          payment_method_types: ["card"],
        });

        res.json({
          clientSecret: paymentIntent.client_secret,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Post Payment History (VerifyJWT)
    app.post("/payment-history", verifyJWT, verifyMember, async (req, res) => {
      try {
        const paymentInfo = req.body;

        const existingPayment = await paymentHistoryCollection.findOne({
          userEmail: paymentInfo.userEmail,
          month: paymentInfo.month,
        });

        if (existingPayment) {
          return res.status(400).json({
            message: `You have already paid for ${paymentInfo.month}`,
          });
        }

        const result = await paymentHistoryCollection.insertOne({
          ...paymentInfo,
          paymentStatus: "paid",
          paidAt: new Date(),
        });

        res.status(200).json({
          message: "Payment saved successfully",
          result,
        });
      } catch (error) {
        res.status(500).json({
          message: "Server error",
          error: error.message,
        });
      }
    });

    // Loading Payment History
    app.get(
      "/my-payment-history/:email",
      verifyJWT,
      verifyMember,
      async (req, res) => {
        try {
          const email = req.params.email;

          const payments = await paymentHistoryCollection
            .find({ userEmail: email })
            .sort({ paidAt: -1 })
            .toArray();

          res.send(payments);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      },
    );

    // Load Apartment Info (VerifyJWT)
    app.get(
      "/apartment-info/:email",
      verifyJWT,
      verifyMember,
      async (req, res) => {
        try {
          const email = req.params.email;

          const apartmentInfo = await applicationsCollection.findOne(
            { userEmail: email },
            {
              projection: {
                floorNo: 1,
                blockName: 1,
                apartmentNo: 1,
                _id: 0,
              },
            },
          );

          res.send(apartmentInfo);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      },
    );

    // Loading Coupons (VerifyJWT, VerifyAdmin)
    app.get("/coupons", verifyJWT, async (req, res) => {
      const result = await couponsCollection.find().toArray();
      res.send(result);
    });

    // Posting Announcement (VerifyJWT, VerifyAdmin)
    app.post("/make-announcement", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const announcements = req.body;
        const result = await announcementsCollection.insertOne(announcements);
        res.status(200).json({ message: "Announcement received successfully" });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Post Coupons In DB (VerifyJWT, VerifyAdmin)
    app.post("/post-coupons", async (req, res) => {
      const coupon = req.body;
      coupon.discountPercentage = parseInt(coupon.discountPercentage, 10);
      const result = await couponsCollection.insertOne(coupon);
      res.status(200).json({ message: "Coupon Added Successfully" });
    });

    // Loading Members Data (VerifyJWT, VerifyAdmin)
    app.get("/manage-members", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find({ role: "member" }).toArray();
      res.send(result);
    });

    // Remove Member By Email (VerifyJWT, VerifyAdmin)
    app.patch(
      "/remove-member/:email",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const memberEmail = req.params.email;
        try {
          const result = await usersCollection.findOneAndUpdate(
            { userEmail: memberEmail },
            { $set: { role: "user" } },
            { returnDocument: "after" },
          );
          res.status(200).json({ message: "Member Role Changed To User" });
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      },
    );

    // Load Announcements (VerifyJWT)
    app.get("/announcements", verifyJWT, async (req, res) => {
      try {
        const result = await announcementsCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Posting User Info In User's Collection (VerifyJWT)
    app.post("/users", async (req, res) => {
      const userInfo = req.body;

      const alreadyExists = await usersCollection.findOne({
        userEmail: userInfo.userEmail,
      });

      if (alreadyExists) {
        return res.send({ message: "You're already Registered" });
      }
      const result = await usersCollection.insertOne({
        ...userInfo,
        role: "user",
        registeredAt: new Date(),
      });
      res.send(result);
    });

    // Pagination of Apartments Data Cards
    app.get("/apartment-count", async (req, res) => {
      const count = await apartmentsCollection.estimatedDocumentCount();
      res.send({ count });
    });

    // Admin Stats (VerifyJWT, VerifyAdmin)
    app.get(
      "/admin-profile-stats/:email",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const email = req.params.email;

          const requester = await usersCollection.findOne({
            userEmail: email,
          });

          if (!requester || requester.role !== "admin") {
            return res.status(403).send({
              message: "Forbidden access",
            });
          }

          const totalRoomsData = await apartmentsCollection
            .aggregate([
              {
                $count: "totalRooms",
              },
            ])
            .toArray();

          const unavailableRoomsData = await applicationsCollection
            .aggregate([
              {
                $match: { status: "checked" },
              },
              {
                $count: "unavailableRooms",
              },
            ])
            .toArray();

          const totalUsersData = await usersCollection
            .aggregate([
              {
                $count: "totalUsers",
              },
            ])
            .toArray();

          const totalMembersData = await usersCollection
            .aggregate([
              {
                $match: { role: "member" },
              },
              {
                $count: "totalMembers",
              },
            ])
            .toArray();

          const totalRooms = totalRoomsData[0]?.totalRooms || 0;
          const unavailableRooms =
            unavailableRoomsData[0]?.unavailableRooms || 0;
          const totalUsers = totalUsersData[0]?.totalUsers || 0;
          const totalMembers = totalMembersData[0]?.totalMembers || 0;

          const availableRooms = totalRooms - unavailableRooms;

          const availablePercentage =
            totalRooms > 0
              ? ((availableRooms / totalRooms) * 100).toFixed(2)
              : 0;

          const unavailablePercentage =
            totalRooms > 0
              ? ((unavailableRooms / totalRooms) * 100).toFixed(2)
              : 0;

          res.send({
            totalRooms,
            availablePercentage,
            unavailablePercentage,
            totalUsers,
            totalMembers,
          });
        } catch (error) {
          res.status(500).send({
            error: error.message,
          });
        }
      },
    );

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send(`roleNest is running`);
});

module.exports = app;

app.listen(port, () => {
  console.log(`roleNest server is running in port: ${port}`);
});
