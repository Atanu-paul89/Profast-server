const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const cors = require('cors');
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const streamifier = require("streamifier");
const { MongoClient, ServerApiVersion } = require('mongodb');
const { ObjectId } = require("mongodb");
const jwt = require('jsonwebtoken');
const secret = process.env.JWT_SECRET;


const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

//jwt middle ware // 
const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized access" });
    }

    const token = authHeader.split(' ')[1];

    jwt.verify(token, secret, (err, decoded) => {
        if (err) {
            return res.status(403).send({ message: "Forbidden access" });
        }

        req.decoded = decoded;
        next();
    });
};


async function run() {
    try {
        await client.connect();

        const db = client.db('profast');
        const parcelCollection = db.collection('parcels');
        const userCollection = db.collection('users');
        const trackingCollection = db.collection('tracking');
        const riderCollection = db.collection('rider_form');

        // ***** jwt security API ***** //
        app.post('/jwt', async (req, res) => {
            const { email } = req.body;

            if (!email) {
                return res.status(400).send({ message: "Email is required" });
            }

            const token = jwt.sign({ email }, secret, { expiresIn: '1h' });

            res.send({ token });
        });

        // ***** Rider Releted API ***** // 

        // API: save rider-form data to db // 
        app.post('/apply-rider', async (req, res) => {
            try {
                const formData = req.body;
                const email = formData.email;

                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                // Check if user exists in users collection
                const user = await userCollection.findOne({ email });
                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                // Check if user has already applied
                const lastApplication = await riderCollection.findOne(
                    { email },
                    { sort: { submittedAt: -1 } }
                );

                if (lastApplication && lastApplication.status !== "Rejected") {
                    return res.status(400).send({
                        message: "You have already applied. Please wait for admin review."
                    });
                }

                // If last application was rejected, update it
                if (lastApplication && lastApplication.status === "Rejected") {
                    await riderCollection.updateOne(
                        { _id: lastApplication._id },
                        {
                            $set: {
                                ...formData,
                                status: "Pending",
                                submittedAt: new Date()
                            }
                        }
                    );

                    // Increment application count in users collection
                    await userCollection.updateOne(
                        { email },
                        {
                            $set: { IsRequestedToBeRider: "Yes" },
                            $inc: { AppliedToBeRider: 1 }
                        }
                    );

                    return res.status(200).send({ message: "Re-application submitted successfully" });
                }

                // First-time application
                const newApplication = {
                    ...formData,
                    status: "Pending",
                    submittedAt: new Date()
                };

                await riderCollection.insertOne(newApplication);

                // Update user record
                await userCollection.updateOne(
                    { email },
                    {
                        $set: { IsRequestedToBeRider: "Yes" },
                        $inc: { AppliedToBeRider: 1 }
                    }
                );

                res.status(201).send({ message: "Application submitted successfully" });

            } catch (error) {
                console.error("Error submitting rider application:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // API: Get rider application by email
        app.get('/rider-form/:email', async (req, res) => {
            try {
                const { email } = req.params;
                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                const riderApp = await riderCollection.findOne(
                    { email },
                    { sort: { submittedAt: -1 } } // get the latest application
                );

                if (!riderApp) {
                    return res.status(404).send({ message: "No rider application found" });
                }

                res.status(200).send(riderApp);
            } catch (error) {
                console.error("Error fetching rider application:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });




        // ***** Parcel Releted API ***** ///

        // API: Get parcels (optionally by user email)
        app.get('/parcels', verifyJWT, async (req, res) => {
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

        // API: add parcels to db & create intial tracking status //
        app.post('/parcels', async (req, res) => {
            try {
                const newParcel = req.body;

                // Add required fields
                newParcel.createdAt = new Date();
                newParcel.status = "Pending";       // default status
                newParcel.paymentStatus = "Not Paid"; // default payment

                // Save parcel
                const result = await parcelCollection.insertOne(newParcel);

                // ✅ Add initial tracking log
                if (result.insertedId) {
                    await trackingCollection.insertOne({
                        tracking_Id: newParcel.trackingId || newParcel.tracking_Id, // handle both naming styles
                        parcel_id: result.insertedId,
                        status: "Pending",
                        message: "Parcel created and awaiting pickup",
                        time: new Date(),
                        updated_by: "System"
                    });
                }

                res.status(201).send(result);
            } catch (error) {
                console.error("Error inserting parcel: ", error);
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });


        // API: Cancel parcel with rules and regulations //
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

        // API: Delete parcel //
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

        // API: Get parcel by trackingId //
        app.get('/parcels/:trackingId', verifyJWT, async (req, res) => {
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



        // ***** Tracking Releted API ***** ///

        // API: Get parcel by parcelId
        app.get('/tracking/:parcelId', verifyJWT, async (req, res) => {
            const { parcelId } = req.params;

            try {
                const logs = await trackingCollection
                    .find({ parcel_id: new ObjectId(parcelId) })
                    .sort({ time: 1 }) // chronological order
                    .toArray();

                res.send(logs);
            } catch (error) {
                console.error("Error fetching tracking logs:", error);
                res.status(500).send({ message: "Failed to fetch tracking logs" });
            }
        });

        // API: Tracking the parcel
        app.post('/tracking', async (req, res) => {
            const { tracking_Id, parcel_id, status, message, updated_by = '' } = req.body;

            const log = {
                tracking_Id,
                parcel_id: parcel_id ? new ObjectId(parcel_id) : undefined,
                status,
                message,
                time: new Date(),
                updated_by,
            };

            const result = await trackingCollection.insertOne(log);

            // ✅ Always update parcel's latest status
            if (parcel_id) {
                await parcelCollection.updateOne(
                    { _id: new ObjectId(parcel_id) },
                    { $set: { status } }
                );
            }

            res.send({ success: true, insertedId: result.insertedId });
        });


        // ***** Payment Releted API ***** ///

        // API: Patment intending for Stripe //
        app.post('/create-payment-intent', async (req, res) => {
            const amountInCents = req.body.amountInCents;
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amountInCents,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });
                res.json({ clientSecret: paymentIntent.client_secret });
            }
            catch (error) {
                res.status(500).json({ error: error.message });
            }
        })

        // API: Update payment status and save payment info
        app.patch('/parcels/:trackingId/payment', async (req, res) => {
            try {
                const { trackingId } = req.params;
                const { paymentIntentId, amount, payerEmail } = req.body;

                const update = {
                    paymentStatus: "Paid",
                    paymentInfo: {
                        paymentIntentId,
                        amount,
                        paidAt: new Date(),
                        payerEmail
                    }
                };

                const result = await parcelCollection.updateOne(
                    { trackingId },
                    { $set: update }
                );

                if (result.modifiedCount > 0) {
                    res.send({ success: true });
                } else {
                    res.status(404).send({ success: false, message: "Parcel not found" });
                }
            } catch (error) {
                console.error("Error updating payment info:", error);
                res.status(500).send({ success: false, message: "Failed to update payment info" });
            }
        });


        // ***** User Releted API ***** ///

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

        // API: Create or update user 
        app.post('/users', async (req, res) => {
            try {
                const user = { ...req.body };

                if (!user.email || typeof user.email !== 'string') {
                    return res.status(400).send({ message: "Invalid or missing email" });
                }

                delete user._id; // make sure _id isn’t sent

                const result = await userCollection.updateOne(
                    { email: user.email },        // find by email
                    { $set: user },               // update with new data
                    { upsert: true }              // insert if not found
                );

                const isNewUser = result.upsertedCount > 0;

                res.status(200).send({
                    success: true,
                    isNewUser,
                    message: isNewUser ? "User created successfully" : "User updated successfully"
                });

            } catch (error) {
                console.error("Error saving user:", error);
                res.status(500).send({ message: "Failed to save user" });
            }
        });

        // API: Get all users
        app.get('/users', verifyJWT, async (req, res) => {
            try {
                const users = await userCollection.find().toArray();
                res.status(200).send(users);
            } catch (error) {
                console.error("Error fetching users:", error);
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        // API: Get user by email
        app.get('/users/:email', verifyJWT, async (req, res) => {
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



