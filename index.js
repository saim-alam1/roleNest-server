const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

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
    app.get("/agreement-requests", async (req, res) => {
      const result = await applicationsCollection
        .find({ status: "pending" })
        .toArray();
      res.send(result);
    });

    // Get All Agreement Requests (VerifyJWT)
    app.get("/approved-agreement/:email", async (req, res) => {
      const email = req.params.email;
      const result = await applicationsCollection.findOne({ userEmail: email });
      res.send(result);
    });

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

    // Post Payment Month (VerifyJWT)
    app.patch("/payment-month/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { month } = req.body;

        const existingUser = await applicationsCollection.findOne({
          userEmail: email,
        });

        if (existingUser?.month === month) {
          return res.status(400).json({
            message: "You already selected this month",
          });
        }

        // Update the month
        const result = await applicationsCollection.findOneAndUpdate(
          { userEmail: email },
          { $set: { month } },
          { returnDocument: "after" },
        );

        res
          .status(200)
          .json({ message: "Payment month saved successfully", result });
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

    // Post Payment Info (VerifyJWT)
    app.patch("/payment-info/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const { couponCode, finalRent, transactionId } = req.body;

        if (!finalRent || !transactionId) {
          return res
            .status(400)
            .json({ message: "Missing required payment fields" });
        }

        const result = await applicationsCollection.findOneAndUpdate(
          { userEmail: email },
          {
            $set: { couponCode, finalRent, transactionId, paidAt: new Date() },
          },
          { returnDocument: "after" },
        );

        res
          .status(200)
          .json({ message: "Payment info saved successfully", result });
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    // Loading Coupons (VerifyJWT, VerifyAdmin)
    app.get("/coupons", async (req, res) => {
      const result = await couponsCollection.find().toArray();
      res.send(result);
    });

    // Posting Announcement (VerifyJWT, VerifyAdmin)
    app.post("/make-announcement", async (req, res) => {
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
    app.get("/manage-members", async (req, res) => {
      const result = await usersCollection.find({ role: "member" }).toArray();
      res.send(result);
    });

    // Remove Member By Email (VerifyJWT, VerifyAdmin)
    app.patch("/remove-member/:email", async (req, res) => {
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
    });

    // Load Announcements (VerifyJWT)
    app.get("/announcements", async (req, res) => {
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
