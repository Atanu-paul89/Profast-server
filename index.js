const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const streamifier = require("streamifier");
const { MongoClient, ServerApiVersion } = require('mongodb');
const { ObjectId } = require("mongodb");


dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

//setting up cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// memory set up by multer to stem to cloudinary
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Mongo DB URI
const uri = `${process.env.MONGODB_URI}`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();

        const db = client.db('profast');
        const parcelCollection = db.collection('parcels');
        const userCollection = db.collection('users');


        // API: Get parcels (optionally by user email)
        app.get('/parcels', async (req, res) => {
            try {
                const { email } = req.query; // ?email=user@gmail.com

                let query = {};
                if (email) {
                    query = { "createdBy.email": email };
                }

                // sort latest first by createdAt
                const parcels = await parcelCollection
                    .find(query)
                    .sort({ createdAt: -1 }) // latest first
                    .toArray();

                res.send(parcels);
            } catch (error) {
                console.error("Error fetching parcels:", error);
                res.status(500).send({ message: "Failed to fetch parcels" });
            }
        });

        // API: add parcels to db //
        app.post('/parcels', async (req, res) => {
            try {
                const newParcel = req.body;

                // Add required fields
                newParcel.createdAt = new Date();
                newParcel.status = "Pending"; // default status
                newParcel.paymentStatus = "Not Paid"; // default status

                const result = await parcelCollection.insertOne(newParcel);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error inserting parcel: ", error);
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });


        // API: Get parcel by trackingId
        app.get('/parcels/:trackingId', async (req, res) => {
            try {
                const { trackingId } = req.params;

                if (!trackingId) {
                    return res.status(400).send({ message: "Tracking ID is required" });
                }

                const parcel = await parcelCollection.findOne({ trackingId });

                if (!parcel) {
                    return res.status(404).send({ message: "Parcel not found" });
                }

                res.send(parcel);
            } catch (error) {
                console.error("Error fetching parcel by trackingId:", error);
                res.status(500).send({ message: "Failed to fetch parcel" });
            }
        });


        // API: Cancel parcel with rules and regulations 
        app.patch("/parcels/:id/cancel", async (req, res) => {
            try {
                const { id } = req.params;
                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

                if (!parcel) {
                    return res.status(404).send({ message: "Parcel not found" });
                }

                // --- Business rules ---
                const createdAt = new Date(parcel.createdAt);
                const now = new Date();
                const hoursDiff = (now - createdAt) / (1000 * 60 * 60);

                // Rule 1: Cannot cancel if same region + same central hub
                if (
                    parcel.senderRegion === parcel.receiverRegion &&
                    parcel.senderWarehouse === "Central Hub" &&
                    parcel.receiverWarehouse === "Central Hub"
                ) {
                    return res
                        .status(400)
                        .send({ message: "Parcel cannot be cancelled (same regional central hub)." });
                }

                // Rule 2: Must be within 24 hours
                if (hoursDiff > 24) {
                    return res
                        .status(400)
                        .send({ message: "Parcel can only be cancelled within 24 hours." });
                }

                // Rule 3: Same region but different hubs → within 8 hours
                if (
                    parcel.senderRegion === parcel.receiverRegion &&
                    parcel.senderWarehouse !== parcel.receiverWarehouse &&
                    hoursDiff > 8
                ) {
                    return res
                        .status(400)
                        .send({ message: "Parcel can only be cancelled within 8 hours for same region but different hub." });
                }

                // ✅ Update status
                const result = await parcelCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "Cancelled" } }
                );

                res.send({ success: true, result });
            }
            catch (error) {
                console.error("Error cancelling parcel:", error);
                res.status(500).send({ message: "Failed to cancel parcel" });
            }
        });

        // API: Delete parcel
        app.delete("/parcels/:id", async (req, res) => {
            try {
                const { id } = req.params;
                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });

                if (!parcel) {
                    return res.status(404).send({ message: "Parcel not found" });
                }

                if (parcel.status !== "Delivered" && parcel.status !== "Cancelled") {
                    return res
                        .status(400)
                        .send({ message: "Only delivered or cancelled parcels can be deleted." });
                }

                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) });
                res.send({ success: true, result });
            } catch (error) {
                console.error("Error deleting parcel:", error);
                res.status(500).send({ message: "Failed to delete parcel" });
            }
        });



        // API: Upload user profile photo to Cloudinary and get the image URL
        app.post("/upload-photo", upload.single("photo"), async (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({ message: "No file uploaded" });
                }

                // Upload buffer to Cloudinary
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "zapshift_profiles" }, // Cloudinary folder
                    (error, result) => {
                        if (error) {
                            console.error("Cloudinary Upload Error:", error);
                            return res.status(500).json({ message: "Upload failed" });
                        }

                        // ✅ Send back the secure URL
                        res.status(200).json({ url: result.secure_url });
                    }
                );

                streamifier.createReadStream(req.file.buffer).pipe(stream);
            } catch (error) {
                console.error("Upload API Error:", error);
                res.status(500).json({ message: "Upload failed" });
            }
        });

        // Create or update user
        app.post('/users', async (req, res) => {
            try {
                const user = { ...req.body };
                console.log("Incoming user data:", user);

                if (!user.email || typeof user.email !== 'string') {
                    return res.status(400).send({ message: "Invalid or missing email" });
                }

                delete user._id; // ✅ Remove _id before updating

                const result = await userCollection.updateOne(
                    { email: user.email },
                    { $set: user },
                    { upsert: true }
                );

                console.log("MongoDB update result:", result);
                res.status(200).send(result);
            } catch (error) {
                console.error("Error saving user:", error);
                res.status(500).send({ message: "Failed to save user" });
            }
        });

        // Get all users
        app.get('/users', async (req, res) => {
            try {
                const users = await userCollection.find().toArray();
                res.status(200).send(users);
            } catch (error) {
                console.error("Error fetching users:", error);
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        // Get user by email
        app.get('/users/:email', async (req, res) => {
            try {
                const email = req.params.email;
                const user = await userCollection.findOne({ email });

                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }
                res.send(user);
            } catch (error) {
                console.error("Error fetching user:", error);
                res.status(500).send({ message: "Failed to fetch user" });
            }
        });



        // testing if server is running or not : but need to comment before deploying on varcel
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB:Profast!");
    }

    finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send("Parcel server is running");
});

app.listen(port, () => {
    console.log(`server is listening on port ${port}`);
});