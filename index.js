//#region initial require parameters
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

//#endregion

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
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

        //* #region Defining all DB Collectections here 
        const db = client.db('profast');
        const parcelCollection = db.collection('parcels');
        const userCollection = db.collection('users');
        const trackingCollection = db.collection('tracking');
        const riderCollection = db.collection('rider_form');
        const activeRiderCollection = db.collection('active_riders');
        const logCollection = db.collection('admin_logs');
        const paymentCollection = db.collection('payments');
        const notificationCollection = db.collection('notifications');

        //#endregion


        // #region ( function of JWT configure/ admin verify / jwt middleware)
        // ***** jwt config & API  ***** //

        // jwt middle ware // 
        const verifyJWT = async (req, res, next) => {
            const authHeader = req.headers.authorization;

            if (!authHeader) {
                return res.status(401).send({ message: "Unauthorized access" });
            }

            const token = authHeader.split(' ')[1];

            jwt.verify(token, secret, async (err, decoded) => {
                if (err) {
                    return res.status(403).send({ message: "Forbidden access" });
                }

                req.decoded = decoded;

                // ✅ Check if user is restricted
                const user = await userCollection.findOne({ email: decoded.email });
                if (user?.isRestricted) {
                    return res.status(403).send({ message: "Access denied. User is restricted." });
                }
                next();
            });
        };

        // jwt security API // 
        app.post('/jwt', async (req, res) => {
            const { email } = req.body;

            if (!email) {
                return res.status(400).send({ message: "Email is required" });
            }

            // ✅ Check if user is restricted
            const user = await userCollection.findOne({ email });
            if (!user) {
                return res.status(404).send({ message: "User not found" });
            }

            if (user.isRestricted) {
                return res.status(403).send({ message: "Access denied. Your account is restricted." });
            }

            const token = jwt.sign({ email }, secret, { expiresIn: '1h' });

            res.send({ token });
        });

        // ***** ADMIN setup and verified ***** // 
        const verifyAdmin = async (req, res, next) => {
            const user = await userCollection.findOne({ email: req.decoded.email });
            if (user?.role !== "admin") {
                return res.status(403).send({ message: "Forbidden" });
            }
            next();
        };

        // #endregion


        // #region ***** Rider & Rider APllication Releted API *****  

        // API: save rider-form data to db // 
        app.post('/apply-rider', async (req, res) => {
            try {
                const formData = req.body;
                const email = formData.email;

                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                // ✅ Check if user exists
                const user = await userCollection.findOne({ email });
                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                // ✅ Check latest application
                const lastApplication = await riderCollection.findOne(
                    { email },
                    { sort: { submittedAt: -1 } }
                );

                // ✅ Block if already applied and not rejected/canceled
                if (lastApplication && !["Rejected", "Canceled"].includes(lastApplication.status)) {
                    return res.status(400).send({
                        message: "You have already applied. Please wait for admin review."
                    });
                }

                // ✅ Re-application: preserve original date
                if (lastApplication && ["Rejected", "Canceled"].includes(lastApplication.status)) {
                    const firstSubmittedAt = lastApplication.firstSubmittedAt || lastApplication.submittedAt;

                    await riderCollection.updateOne(
                        { _id: lastApplication._id },
                        {
                            $set: {
                                ...formData,
                                status: "Pending",
                                submittedAt: new Date(),
                                firstSubmittedAt // ✅ Preserve original date
                            }
                        }
                    );

                    await userCollection.updateOne(
                        { email },
                        {
                            $set: { IsRequestedToBeRider: "Yes" },
                            $inc: { AppliedToBeRider: 1 }
                        }
                    );

                    return res.status(200).send({ message: "Re-application submitted successfully" });
                }

                // ✅ First-time application
                const now = new Date();
                const newApplication = {
                    ...formData,
                    status: "Pending",
                    submittedAt: now,
                    firstSubmittedAt: now
                };

                await riderCollection.insertOne(newApplication);

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

        // API: Get rider application data by email for merchant user
        app.get('/rider-form/:email', verifyJWT, async (req, res) => {
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

        // API: Cancel rider application by marchant user
        app.patch('/rider-form/:email/cancel', verifyJWT, async (req, res) => {
            try {
                const { email } = req.params;

                if (!email) {
                    return res.status(400).send({ message: "Email is required" });
                }

                // Find latest application
                const lastApplication = await riderCollection.findOne(
                    { email },
                    { sort: { submittedAt: -1 } }
                );

                if (!lastApplication) {
                    return res.status(404).send({ message: "No application found to cancel" });
                }

                // Only Pending apps can be cancelled
                if (lastApplication.status !== "Pending") {
                    return res.status(400).send({
                        message: `Cannot cancel an application with status: ${lastApplication.status}`
                    });
                }

                // Update status → Canceled
                await riderCollection.updateOne(
                    { _id: lastApplication._id },
                    {
                        $set: {
                            status: "Canceled",
                            canceledAt: new Date()
                        }
                    }
                );

                // Update user record (keep AppliedToBeRider count, but mark as not currently requested)
                await userCollection.updateOne(
                    { email },
                    { $set: { IsRequestedToBeRider: "No" } }
                );

                res.status(200).send({ message: "Application cancelled successfully" });

            } catch (error) {
                console.error("Error cancelling rider application:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API: View All Rider Applications
        app.get('/admin/rider-applications', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const applications = await riderCollection
                    .find({})
                    .sort({ firstSubmittedAt: 1 }) // earliest first
                    .toArray();

                const formatted = applications.map(app => ({
                    _id: app._id?.toString() ?? null,
                    name: app.name ?? "N/A",
                    age: app.age ?? "N/A",
                    email: app.email ?? "N/A",
                    region: app.region ?? "N/A",
                    nid: app.nid ?? "N/A",
                    contact: app.contact ?? "N/A",
                    gender: app.gender ?? "N/A",
                    dob: app.dob ?? "N/A",
                    nidLink: app.nidLink ?? "N/A",
                    district: app.district ?? "N/A",
                    hasLicense: app.hasLicense ?? "No",
                    licenseType: app.licenseType ?? "N/A",
                    vehicleType: app.vehicleType ?? "N/A",
                    licenseExpiry: app.licenseExpiry ?? "N/A",
                    status: app.status ?? "Pending",
                    submittedAt: app.submittedAt ?? null,
                    firstSubmittedAt: app.firstSubmittedAt ?? app.submittedAt ?? null,
                    canceledAt: app.canceledAt ?? null,
                    feedback: app.feedback ?? "No feedback yet"
                }));

                res.status(200).send(formatted);
            } catch (error) {
                console.error("Error fetching rider applications:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API:  Actions on Rider Applications (Approve/Reject)
        app.patch('/admin/rider-applications/:email/status', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;
                const { status, feedback } = req.body;

                // ✅ Validate status
                if (!["Approved", "Rejected"].includes(status)) {
                    return res.status(400).send({ message: "Invalid status" });
                }

                // ✅ Find latest application
                const latestApp = await riderCollection.findOne({ email }, { sort: { submittedAt: -1 } });
                if (!latestApp) {
                    return res.status(404).send({ message: "Application not found" });
                }

                // ✅ Extract first name for RiderEmail
                const firstName = latestApp.name?.split(" ")[0]?.toLowerCase() || "rider";
                const riderEmail = `${firstName}.rider@pf.rider.com`;

                // // ✅ Default feedback (always included)
                // const defaultFeedback = `Congratulations. You are selected to be rider.\nPlease create an account with following credentials:\nemail: ${riderEmail}\npassword: @Rider1234 [You can change it from profile]`;

                // // ✅ Combine default + admin feedback
                // const finalFeedback = feedback
                //     ? `${defaultFeedback}\n\nAdditional Note:\n${feedback}`
                //     : defaultFeedback;
                // ✅ Build feedback based on status

                let finalFeedback = "";

                if (status === "Approved") {
                    const defaultFeedback = `Congratulations. You are selected to be a rider.\nPlease create an account with the following credentials:\nemail: ${riderEmail}\npassword: @Rider1234 [You can change it from profile]`;

                    finalFeedback = feedback
                        ? `${defaultFeedback}\n\nAdditional Note:\n${feedback}`
                        : defaultFeedback;
                } else if (status === "Rejected") {
                    const rejectionMessage = "We regret to inform you that your rider application has been rejected.";

                    finalFeedback = feedback
                        ? `${rejectionMessage}\n\nAdditional Note:\n${feedback}`
                        : rejectionMessage;
                }

                // ✅ Update application status and feedback
                await riderCollection.updateOne(
                    { _id: latestApp._id },
                    {
                        $set: {
                            status,
                            feedback: finalFeedback
                        }
                    }
                );

                //  save Data to active_riders if approved
                if (status === "Approved") {
                    // Fetch the user's role from users collection
                    const userDoc = await userCollection.findOne({ email });
                    const userRole = userDoc?.role || "rider"; // fallback in case not found

                    // Remove `status` field from latestApp before inserting
                    const { status: _, ...appDataWithoutStatus } = latestApp;

                    await activeRiderCollection.insertOne({
                        ...appDataWithoutStatus,   // application data (without status)
                        riderStatus: "Active",     // your custom field
                        RiderApplicationApproveAt: new Date(),
                        RiderEmail: riderEmail,
                        role: userRole             // ✅ add role from users collection
                    });
                }

                // ✅ Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: `${status} Rider Application`,
                    targetEmail: email,
                    timestamp: new Date(),
                    details: finalFeedback,
                    viewedByAdmin: false
                });

                // send notifications // 
                await notificationCollection.insertOne({
                    title: "Rider Application Status",
                    message: finalFeedback,
                    type: "Application",
                    time: new Date(),
                    toUser: email,
                    fromAdmin: true,
                    read: false
                });


                res.status(200).send({ message: `Application marked as ${status}` });
            } catch (error) {
                console.error("Error updating application status:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API: Pause/ Resume rider application submission (like currently no receiving any form)
        app.patch('/admin/rider-submission-control', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const { paused } = req.body;

                await db.collection("system_config").updateOne(
                    { key: "riderSubmission" },
                    { $set: { paused } },
                    { upsert: true }
                );

                //  Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: paused ? "Paused Rider Submission" : "Resumed Rider Submission",
                    targetEmail: "System-wide",
                    timestamp: new Date(),
                    details: `Admin ${paused ? "paused" : "resumed"} rider application intake`,
                    viewedByAdmin: false
                });

                await notificationCollection.insertOne({
                    title: paused ? "Rider Submission Paused" : "Rider Submission Resumed",
                    message: `Admin ${paused ? "paused" : "resumed"} rider application intake.`,
                    type: "System",
                    time: new Date(),
                    system: true,
                    fromAdmin: true,
                    read: false
                });


                res.status(200).send({ message: paused ? "Submission paused" : "Submission resumed" });
            } catch (error) {
                console.error("Error updating submission control:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API: get control 
        app.get('/admin/rider-submission-control', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const config = await db.collection("system_config").findOne({ key: "riderSubmission" });
                res.status(200).send({ paused: config?.paused ?? false });
            } catch (error) {
                console.error("Error fetching submission config:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API: Admin can Restrict any specific user from submitting rider application 
        app.patch('/admin/restrict-user/:email', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;
                const { restricted } = req.body;

                await userCollection.updateOne(
                    { email },
                    { $set: { riderFormRestricted: restricted } }
                );

                //  Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: restricted ? "Restricted Rider Form Access" : "Unblocked Rider Form Access",
                    targetEmail: email,
                    timestamp: new Date(),
                    details: `Admin ${restricted ? "blocked" : "unblocked"} user from submitting rider application`,
                    viewedByAdmin: false
                });

                await notificationCollection.insertOne({
                    title: restricted ? "Rider Form Access Restricted" : "Rider Form Access Restored",
                    message: `You have been ${restricted ? "restricted from" : "allowed to"} submitting rider applications.`,
                    type: "Restriction",
                    time: new Date(),
                    toUser: email,
                    fromAdmin: true,
                    read: false
                });


                res.status(200).send({ message: restricted ? "User restricted from applying" : "User unblocked" });
            } catch (error) {
                console.error("Error updating user restriction:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API: deleted rider application data 
        app.delete('/admin/rider-applications/:email', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;

                // ✅ Find latest rider application
                const latestApp = await riderCollection.findOne({ email }, { sort: { submittedAt: -1 } });
                if (!latestApp) {
                    return res.status(404).send({ message: "Application not found" });
                }

                // ✅ Prevent deletion unless status is "Rejected", "Approved", or "Canceled"
                if (
                    latestApp.status !== "Rejected" &&
                    latestApp.status !== "Approved" &&
                    latestApp.status !== "Canceled"
                ) {
                    return res.status(403).send({ message: "Cannot delete application unless it is approved, rejected, or canceled." });
                }

                // ✅ Determine status flag
                let statusFlag = "No";
                if (latestApp.status === "Rejected") {
                    statusFlag = "Rejected & Application Deleted";
                } else if (latestApp.status === "Approved") {
                    statusFlag = "Approved & Application Deleted";
                } else if (latestApp.status === "Canceled") {
                    statusFlag = "Canceled & Application Deleted";
                }

                // ✅ Delete the application
                await riderCollection.deleteOne({ _id: latestApp._id });

                // ✅ Build update payload conditionally
                const updatePayload = {
                    IsRequestedToBeRider: statusFlag,
                    LastRiderApplicationSubmittedAt: latestApp.firstSubmittedAt ?? latestApp.submittedAt,
                    LastRiderApplyFeedback: latestApp.feedback ?? "No feedback provided"
                };

                if (latestApp.canceledAt) {
                    updatePayload.LastCanceledAt = latestApp.canceledAt;
                }

                // ✅ Update user flags and feedback
                await userCollection.updateOne(
                    { email },
                    { $set: updatePayload }
                );

                // ✅ Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Deleted Rider Application",
                    targetEmail: email,
                    timestamp: new Date(),
                    details: `Admin deleted ${latestApp.status.toLowerCase()} rider form submitted on ${new Date(latestApp.submittedAt).toLocaleDateString("en-GB")}, transferred feedback to user profile, and updated status flags`,
                    viewedByAdmin: false
                });

                res.status(200).send({ message: "Application deleted and user profile updated." });
            } catch (error) {
                console.error("Error deleting application:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // #endregion


        // #region ***** Log Releted API ***** ///

        // get all log data (Admin only) 
        app.get('/admin/logs', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const logs = await db.collection("admin_logs")
                    .find({})
                    .sort({ timestamp: -1 }) // latest first
                    .toArray();

                res.status(200).send(logs);
            } catch (error) {
                console.error("Error fetching admin logs:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // Create API to Mark Logs as Seen
        app.patch('/admin/logs/mark-seen', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                await logCollection.updateMany(
                    { viewedByAdmin: false },
                    { $set: { viewedByAdmin: true } }
                );
                res.status(200).send({ message: "Logs marked as viewed" });
            } catch (error) {
                console.error("Error marking logs as seen:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // API to Fetch Unseen Logs,  (kind of notification alert setting up)
        app.get('/admin/logs/unseen', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const unseenLogs = await logCollection.find({ viewedByAdmin: false }).toArray();
                res.status(200).send(unseenLogs);
            } catch (error) {
                console.error("Error fetching unseen logs:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // #endregion


        //#region ***** Parcel Releted API ***** ///

        // API: Get all parcels (optionally by user email)
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
        app.post('/parcels', verifyJWT, async (req, res) => {
            try {
                const newParcel = req.body;

                // Add required fields
                newParcel.createdAt = new Date();
                newParcel.status = "Pending";       // default status
                newParcel.paymentStatus = "Not Paid"; // default payment

                // Save parcel
                const result = await parcelCollection.insertOne(newParcel);

                // Add initial tracking log
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

                await notificationCollection.insertOne({
                    title: "Parcel Created",
                    message: `Your parcel ${newParcel.parcelName} (${newParcel.trackingId}) has been successfully created and is awaiting pickup.`,
                    type: "Parcel",
                    time: new Date(),
                    toUser: newParcel.createdBy?.email || newParcel.userEmail, // adjust based on your schema
                    fromAdmin: false,
                    read: false
                });


                res.status(201).send(result);
            } catch (error) {
                console.error("Error inserting parcel: ", error);
                res.status(500).send({ message: "Failed to create parcel" });
            }
        });

        // API: Cancel parcel with rules and regulations //
        app.patch("/parcels/:id/cancel", verifyJWT, async (req, res) => {
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

                // Update status
                const result = await parcelCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { status: "Cancelled" } }
                );

                await notificationCollection.insertOne({
                    title: "Parcel Cancelled",
                    message: `Your parcel (Tracking Id: ${parcel.trackingId}) was cancelled successfully on ${dayjs().format("D MMM YYYY h:mm A")}.`,
                    type: "Parcel",
                    time: new Date(),
                    toUser: parcel.createdBy?.email || parcel.userEmail,
                    fromAdmin: false,
                    read: false
                });


                res.send({ success: true, result });
            }
            catch (error) {
                console.error("Error cancelling parcel:", error);
                res.status(500).send({ message: "Failed to cancel parcel" });
            }
        });

        // API: Delete parcel by merchant user //
        app.delete("/parcels/:id", verifyJWT, async (req, res) => {
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

                await notificationCollection.insertOne({
                    title: "Parcel Deleted",
                    message: `Your parcel ${parcel.trackingId} has been deleted from the system.`,
                    type: "Parcel",
                    time: new Date(),
                    toUser: parcel.createdBy?.email || parcel.userEmail,
                    fromAdmin: false,
                    read: false
                });

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

        // ADMIN API: Get parcels filtered by status (or exclude Delivered)
        app.get('/admin/parcels-by-status', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const { status } = req.query;

                let query = {};

                if (!status) {
                    return res.status(400).send({ message: "Status is required" });
                }

                if (status === "Pending") {
                    // Show all parcels except Delivered
                    query = { status: { $ne: "Delivered" } };
                } else {
                    // Exact match for other filters
                    query = { status };
                }

                const parcels = await parcelCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .toArray();

                res.send(parcels);
            } catch (error) {
                console.error("Error fetching parcels by status:", error);
                res.status(500).send({ message: "Failed to fetch parcels" });
            }
        });

        // ADMIN API: Update parcel status and sync with tracking collection
        app.patch('/admin/parcels/:id/status', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const { newStatus, updatedBy } = req.body;

                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });
                if (!parcel) {
                    return res.status(404).send({ message: "Parcel not found" });
                }

                await parcelCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $set: {
                            status: newStatus,
                            deliveredAt: newStatus === "Delivered" ? new Date() : null
                        }
                    }
                );

                await trackingCollection.insertOne({
                    tracking_Id: parcel.trackingId,
                    parcel_id: parcel._id,
                    status: newStatus,
                    message: `Status updated to ${newStatus}`,
                    time: new Date(),
                    updated_by: updatedBy || "System"
                });

                await notificationCollection.insertOne({
                    title: "Parcel Status Update",
                    message: `Your parcel ${parcel.trackingId} status changed to ${newStatus}.`,
                    type: "Parcel",
                    time: new Date(),
                    toUser: parcel.createdBy?.email || parcel.userEmail,
                    fromAdmin: true,
                    read: false
                });

                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Updated Parcel Status",
                    targetEmail: parcel.createdBy?.email || parcel.userEmail,
                    timestamp: new Date(),
                    details: `Status changed to "${newStatus}" for parcel ${parcel.trackingId}`,
                    viewedByAdmin: false
                });

                res.send({ success: true });
            } catch (error) {
                console.error("Error updating parcel status:", error);
                res.status(500).send({ message: "Failed to update status" });
            }
        });

        // ADMIN API: Delete parcel (only if Delivered or Cancelled)
        app.delete('/admin/parcels/:id', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;

                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });
                if (!parcel) {
                    return res.status(404).send({ message: "Parcel not found" });
                }

                if (parcel.status !== "Delivered" && parcel.status !== "Cancelled") {
                    return res.status(400).send({ message: "Only delivered or cancelled parcels can be deleted." });
                }

                const result = await parcelCollection.deleteOne({ _id: new ObjectId(id) });

                await notificationCollection.insertOne({
                    title: "Parcel Deleted",
                    message: `Your parcel ${parcel.trackingId} has been deleted by admin.`,
                    type: "Parcel",
                    time: new Date(),
                    toUser: parcel.createdBy?.email || parcel.userEmail,
                    fromAdmin: true,
                    read: false
                });

                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Deleted Parcel",
                    targetEmail: parcel.createdBy?.email || parcel.userEmail,
                    timestamp: new Date(),
                    details: `Parcel ${parcel.trackingId} deleted by admin`,
                    viewedByAdmin: false
                });

                res.send({ success: true, result });
            } catch (error) {
                console.error("Error deleting parcel:", error);
                res.status(500).send({ message: "Failed to delete parcel" });
            }
        });

        // ADMIN API: Get count of parcels grouped by status
        app.get('/admin/parcel-status-counts', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const pipeline = [
                    {
                        $group: {
                            _id: "$status",
                            count: { $sum: 1 }
                        }
                    }
                ];

                const result = await parcelCollection.aggregate(pipeline).toArray();

                const statusCounts = {
                    Pending: 0,
                    PickedUp: 0,
                    InTransit: 0,
                    OutForDelivery: 0,
                    Delivered: 0
                };

                result.forEach(({ _id, count }) => {
                    statusCounts[_id.replace(/\s/g, '')] = count;
                });

                res.send(statusCounts);
            } catch (error) {
                console.error("Error fetching parcel status counts:", error);
                res.status(500).send({ message: "Failed to fetch counts" });
            }
        });

        // ADMIN API: Get parcel overview for a specific user
        app.get('/admin/user-parcel-overview', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const { email } = req.query;

                if (!email) {
                    return res.status(400).send({ message: "User email is required" });
                }

                const total = await parcelCollection.countDocuments({ "createdBy.email": email });
                const delivered = await parcelCollection.countDocuments({ "createdBy.email": email, status: "Delivered" });
                const pending = await parcelCollection.countDocuments({ "createdBy.email": email, status: { $ne: "Delivered" } });

                res.send({ total, delivered, pending });
            } catch (error) {
                console.error("Error fetching user parcel overview:", error);
                res.status(500).send({ message: "Failed to fetch overview" });
            }
        });

        // ADMIN API: Get parcel overview for all users
        app.get('/admin/all-user-parcel-overview', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const users = await userCollection.find({}, { projection: { email: 1, name: 1 } }).toArray();

                const overview = await Promise.all(users.map(async (user) => {
                    const total = await parcelCollection.countDocuments({ "createdBy.email": user.email });
                    const delivered = await parcelCollection.countDocuments({ "createdBy.email": user.email, status: "Delivered" });
                    const pending = await parcelCollection.countDocuments({ "createdBy.email": user.email, status: { $ne: "Delivered" } });

                    return {
                        email: user.email,
                        name: user.name ?? "Unnamed",
                        total,
                        delivered,
                        pending
                    };
                }));

                res.send(overview);
            } catch (error) {
                console.error("Error fetching all user parcel overview:", error);
                res.status(500).send({ message: "Failed to fetch overview" });
            }
        });

        // ADMIN API: Edit parcel details (name, fare, instructions, etc.)
        app.patch('/admin/parcels/:id/edit', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const { id } = req.params;
                const updatedFields = req.body;

                const parcel = await parcelCollection.findOne({ _id: new ObjectId(id) });
                if (!parcel) {
                    return res.status(404).send({ message: "Parcel not found" });
                }

                await parcelCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updatedFields }
                );

                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Edited Parcel",
                    targetEmail: parcel.createdBy?.email || parcel.userEmail,
                    timestamp: new Date(),
                    details: `Parcel ${parcel.trackingId} was edited by admin.`,
                    viewedByAdmin: false
                });

                res.send({ success: true });
            } catch (error) {
                console.error("Error editing parcel:", error);
                res.status(500).send({ message: "Failed to edit parcel" });
            }
        });


        // #endregion *** Parcel Releted APi Ended Here *** // 


        // #region ***** Notifications, Message, Feedback Releted API ***** /// 

        //! Admin's Notification Releted Api  // 

        //* ADMIN API: Creating Notification 
        app.post('/admin/notifications', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const {
                    title,
                    message,
                    type,
                    toUser,
                    toRole,
                    system
                } = req.body;

                const newNotification = {
                    title,
                    message,
                    type,
                    time: new Date(),
                    toUser: toUser || null,
                    toRole: toRole || null,
                    system: system || false,
                    fromAdmin: true,
                    read: false
                };

                const result = await notificationCollection.insertOne(newNotification);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error creating notification:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //* ADMIN API: Update Notification 
        app.patch('/admin/notifications/:id', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const id = req.params.id;
                const updateFields = req.body;

                const result = await notificationCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );

                res.status(200).send(result);
            } catch (error) {
                console.error("Error updating notification:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //* ADMIN API: View All Sent Notifications 
        app.get('/admin/notifications', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const notifications = await notificationCollection
                    .find({ fromAdmin: true })
                    .sort({ time: -1 })
                    .toArray();

                res.status(200).send(notifications);
            } catch (error) {
                console.error("Error fetching notifications:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //* ADMIN API: View Notification for Specific Users 
        app.get('/admin/notifications/:email', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;

                const notifications = await notificationCollection
                    .find({ toUser: email })
                    .sort({ time: -1 })
                    .toArray();

                res.status(200).send(notifications);
            } catch (error) {
                console.error("Error fetching user notifications:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //! User's Notifications Releted Api // 

        //* USer: Get own notification // 
        app.get('/notifications', verifyJWT, async (req, res) => {
            try {
                const email = req.decoded.email;

                const notifications = await notificationCollection
                    .find({
                        $or: [
                            { toUser: email },
                            { toRole: req.decoded.role },
                            { system: true }
                        ]
                    })
                    .sort({ time: -1 })
                    .toArray();

                res.status(200).send(notifications);
            } catch (error) {
                console.error("Error fetching user notifications:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //* marking Notification as read // 
        app.patch('/notifications/:id/read', verifyJWT, async (req, res) => {
            try {
                const id = req.params.id;

                const result = await notificationCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { read: true } }
                );

                res.status(200).send(result);
            } catch (error) {
                console.error("Error marking notification as read:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //! Message Releted API  // 

        //* Send Message to ADmin // 
        app.post('/notifications/message-to-admin', verifyJWT, async (req, res) => {
            try {
                const { title, message } = req.body;

                const newMessage = {
                    title,
                    message,
                    type: "Message",
                    time: new Date(),
                    toUser: "admin@profast.com",
                    fromAdmin: false,
                    read: false,
                    senderEmail: req.decoded.email
                };

                const result = await notificationCollection.insertOne(newMessage);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error sending message to admin:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //* ADMIN API: Admin Reply to User's Message 
        app.post('/admin/reply/:notificationId', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const originalId = req.params.notificationId;
                const { title, message } = req.body;

                const original = await notificationCollection.findOne({ _id: new ObjectId(originalId) });
                if (!original || !original.senderEmail) {
                    return res.status(404).send({ message: "Original message not found" });
                }

                const reply = {
                    title,
                    message,
                    type: "Reply",
                    time: new Date(),
                    toUser: original.senderEmail,
                    fromAdmin: true,
                    read: false,
                    replyTo: originalId
                };

                const result = await notificationCollection.insertOne(reply);
                res.status(201).send(result);
            } catch (error) {
                console.error("Error sending reply:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //! Feedback Releted API // 

        //* api for posting feedback by users //
        app.post('/feedback', verifyJWT, async (req, res) => {
            try {
                const {
                    title,
                    message,
                    rating,
                    parcelId,
                    riderEmail,
                    type // "System", "Parcel", "Rider"
                } = req.body;

                const senderEmail = req.decoded.email;

                // Save feedback as a notification
                const feedbackNotification = {
                    title,
                    message,
                    type: "Feedback",
                    time: new Date(),
                    fromAdmin: false,
                    read: false,
                    senderEmail,
                    relatedParcelId: parcelId || null,
                    relatedRiderEmail: riderEmail || null,
                    rating: rating || null,
                    toUser: "admin@profast.com" // Admin always receives feedback
                };

                const result = await notificationCollection.insertOne(feedbackNotification);

                // Optional: Notify rider if feedback is about them
                if (riderEmail) {
                    await notificationCollection.insertOne({
                        title: "New Rider Feedback",
                        message: `You received feedback from ${senderEmail}: "${message}"`,
                        type: "Feedback",
                        time: new Date(),
                        fromAdmin: false,
                        read: false,
                        toUser: riderEmail,
                        relatedParcelId: parcelId || null,
                        rating: rating || null
                    });
                }

                res.status(201).send({ message: "Feedback submitted successfully" });
            } catch (error) {
                console.error("Error submitting feedback:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });


        //#endregion *** Notfication Releted API Eneded here ***** ///


        //  #region ***** Tracking Releted API ***** ///

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

            // Always update parcel's latest status
            if (parcel_id) {
                await parcelCollection.updateOne(
                    { _id: new ObjectId(parcel_id) },
                    { $set: { status } }
                );
            }

            res.send({ success: true, insertedId: result.insertedId });
        });

        //#endregion *** Tracking Releted APi Ended Here *** //


        //#region ***** Payment Releted API ***** ///

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
        app.patch('/parcels/:trackingId/payment', verifyJWT, async (req, res) => {
            try {
                const { trackingId } = req.params;
                const { paymentIntentId, amount, payerEmail } = req.body;

                const parcel = await parcelCollection.findOne({ trackingId });
                if (!parcel) {
                    return res.status(404).send({ success: false, message: "Parcel not found" });
                }

                if (parcel.paymentStatus === "Paid") {
                    return res.status(409).send({ success: false, message: "Parcel already paid" });
                }

                const paymentInfo = {
                    paymentIntentId,
                    amount,
                    paidAt: new Date(),
                    payerEmail
                };

                // ✅ Update parcel with payment info
                await parcelCollection.updateOne(
                    { trackingId },
                    {
                        $set: {
                            paymentStatus: "Paid",
                            paymentInfo
                        }
                    }
                );

                // ✅ Insert into payments collection for admin
                await paymentCollection.insertOne({
                    paymentIntentId,
                    amount,
                    paidAt: new Date(),
                    payerEmail,
                    payerName: parcel.createdBy?.name ?? "Unknown",
                    trackingId,
                    parcelType: parcel.parcelType,
                    region: parcel.senderRegion,
                    receiverRegion: parcel.receiverRegion
                });

                await notificationCollection.insertOne({
                    title: "Payment Successful",
                    message: `Your payment of Tk. ${amount} for parcel ${trackingId} was successful.`,
                    type: "Payment",
                    time: new Date(),
                    toUser: payerEmail,
                    fromAdmin: false,
                    read: false
                });


                res.send({ success: true });
            } catch (error) {
                console.error("Error updating payment info:", error);
                res.status(500).send({ success: false, message: "Failed to update payment info" });
            }
        });

        // ADMIN API: View all payments by the users
        app.get('/admin/payments/:email', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;
                const payments = await paymentCollection.find({ payerEmail: email }).toArray();

                if (payments.length === 0) {
                    return res.status(200).send({ message: "This user has not paid for any parcel yet", payments: [] });
                }

                res.status(200).send({ payments });
            } catch (error) {
                console.error("Error fetching payments:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        // ADMIN API: Delete Payment data of users 
        app.delete('/admin/payments/:id', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const id = req.params.id;

                //  Fetch payment record first
                const paymentRecord = await paymentCollection.findOne({ _id: new ObjectId(id) });
                if (!paymentRecord) {
                    return res.status(404).send({ message: "Payment record not found" });
                }

                //  Delete after fetching
                const result = await paymentCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ message: "Payment record not found" });
                }

                //  Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Deleted Payment Record",
                    targetEmail: paymentRecord.payerEmail,
                    timestamp: new Date(),
                    details: `Admin deleted payment record for parcel ${paymentRecord.trackingId} paid by ${paymentRecord.payerEmail}`,
                    viewedByAdmin: false
                });

                await notificationCollection.insertOne({
                    title: "Payment Record Deleted",
                    message: `Your payment record for parcel ${paymentRecord.trackingId} has been deleted by admin.`,
                    type: "Payment",
                    time: new Date(),
                    toUser: paymentRecord.payerEmail,
                    fromAdmin: true,
                    read: false
                });


                res.status(200).send({ message: "Payment record deleted successfully" });
            } catch (error) {
                console.error("Error deleting payment record:", error);
                res.status(500).send({ message: "Internal server error" });
            }
        });

        //temporary api to redirect users payment  data to new collection // [worked fine, data moved *****] 
        // app.post('/admin/migrate-payments', verifyJWT, verifyAdmin, async (req, res) => {
        //     try {
        //         const paidParcels = await parcelCollection.find({ paymentStatus: "Paid" }).toArray();

        //         const migratedPayments = [];

        //         for (const parcel of paidParcels) {
        //             const paymentInfo = parcel.paymentInfo;
        //             if (!paymentInfo || !paymentInfo.paymentIntentId) continue;

        //             const alreadyExists = await paymentCollection.findOne({ paymentIntentId: paymentInfo.paymentIntentId });
        //             if (alreadyExists) continue;

        //             migratedPayments.push({
        //                 paymentIntentId: paymentInfo.paymentIntentId,
        //                 amount: paymentInfo.amount,
        //                 paidAt: paymentInfo.paidAt,
        //                 payerEmail: paymentInfo.payerEmail,
        //                 payerName: parcel.createdBy?.name ?? "Unknown",
        //                 trackingId: parcel.trackingId,
        //                 parcelType: parcel.parcelType,
        //                 region: parcel.senderRegion,
        //                 receiverRegion: parcel.receiverRegion
        //             });
        //         }

        //         if (migratedPayments.length > 0) {
        //             await paymentCollection.insertMany(migratedPayments);
        //         }

        //         res.send({
        //             success: true,
        //             inserted: migratedPayments.length,
        //             message: `${migratedPayments.length} payment records migrated successfully.`
        //         });
        //     } catch (error) {
        //         console.error("Migration error:", error);
        //         res.status(500).send({ success: false, message: "Migration failed." });
        //     }
        // });

        //#endregion *** Payment Releted Api Ended Here *** //


        //#region ***** User Releted API ***** ///

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

                        // Send back the secure URL
                        res.status(200).json({ url: result.secure_url });
                    }
                );

                streamifier.createReadStream(req.file.buffer).pipe(stream);
            } catch (error) {
                console.error("Upload API Error:", error);
                res.status(500).json({ message: "Upload failed" });
            }
        });

        // API: Create & update user information 
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

                await notificationCollection.insertOne({
                    title: isNewUser ? "Welcome to Profast!" : "Profile Updated",
                    message: isNewUser
                        ? "Your account has been created successfully. You can now start using Profast."
                        : "Your profile information has been updated.",
                    type: isNewUser ? "Welcome" : "Profile",
                    time: new Date(),
                    toUser: user.email,
                    fromAdmin: false,
                    read: false
                });


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

        // API: Get all users data
        app.get('/users', verifyJWT, async (req, res) => {
            try {
                const users = await userCollection.find().toArray();
                res.status(200).send(users);
            } catch (error) {
                console.error("Error fetching users:", error);
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        // API: Get specific user data by their email
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

        // ADMIN API: update the role of the users 
        app.patch('/users/:email/role', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;
                const { role } = req.body;

                if (!role) {
                    return res.status(400).send({ message: "Role is required" });
                }

                const result = await userCollection.updateOne(
                    { email },
                    { $set: { role } }
                );

                // Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Updated User Role",
                    targetEmail: email,
                    timestamp: new Date(),
                    details: `Role changed to "${role}"`,
                    viewedByAdmin: false
                });

                await notificationCollection.insertOne({
                    title: "Role Updated",
                    message: `Your account role has been updated to "${role}" by an admin.`,
                    type: "Role",
                    time: new Date(),
                    toUser: email,
                    fromAdmin: true,
                    read: false
                });


                res.status(200).send({ message: "Role updated successfully" });
            } catch (error) {
                console.error("Error updating role:", error);
                res.status(500).send({ message: "Failed to update role" });
            }
        });

        // ADMIN API: restrict users from accessing the system (can not log in) 
        app.patch('/users/:email/restrict', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;
                const { restricted } = req.body;

                //  Fetch user first
                const user = await userCollection.findOne({ email });
                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                //  Prevent restriction if user is admin
                if (user.role === "admin") {
                    return res.status(403).send({ message: "Admin users cannot be restricted" });
                }

                await userCollection.updateOne(
                    { email },
                    { $set: { isRestricted: restricted } }
                );

                //  Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: restricted ? "Restricted System Access" : "Unblocked System Access",
                    targetEmail: email,
                    timestamp: new Date(),
                    details: `Admin ${restricted ? "blocked" : "unblocked"} user from logging into the system`,
                    viewedByAdmin: false
                });

                await notificationCollection.insertOne({
                    title: restricted ? "Access Restricted" : "Access Restored",
                    message: `Your account has been ${restricted ? "restricted from" : "restored to"} system access.`,
                    type: "Restriction",
                    time: new Date(),
                    toUser: email,
                    fromAdmin: true,
                    read: false
                });


                res.status(200).send({ message: restricted ? "User restricted" : "User unblocked" });
            } catch (error) {
                console.error("Error updating restriction:", error);
                res.status(500).send({ message: "Failed to update restriction" });
            }
        });

        //ADMIN API: Delete users data from DB permanently 
        app.delete('/users/:email', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const email = req.params.email;

                //  Fetch user first
                const user = await userCollection.findOne({ email });
                if (!user) {
                    return res.status(404).send({ message: "User not found" });
                }

                //  Prevent deletion if user is admin
                if (user.role === "admin") {
                    return res.status(403).send({ message: "Admin users cannot be deleted" });
                }

                const result = await userCollection.deleteOne({ email });

                //  Insert audit log
                await logCollection.insertOne({
                    adminEmail: req.decoded.email,
                    actionType: "Deleted User Account",
                    targetEmail: email,
                    timestamp: new Date(),
                    details: `Admin permanently deleted user with role "${user.role}" and contact "${user.contactNo ?? "N/A"}"`,
                    viewedByAdmin: false
                });

                res.status(200).send({ message: "User deleted successfully" });
            } catch (error) {
                console.error("Error deleting user:", error);
                res.status(500).send({ message: "Failed to delete user" });
            }
        });

        // ADMIN API: Get all users (for dropdown selection)
        app.get('/admin/users', verifyJWT, verifyAdmin, async (req, res) => {
            try {
                const users = await userCollection
                    .find({}, { projection: { email: 1, name: 1 } })
                    .sort({ name: 1 })
                    .toArray();

                res.send(users);
            } catch (error) {
                console.error("Error fetching users:", error);
                res.status(500).send({ message: "Failed to fetch users" });
            }
        });

        //#endregion *** User Releted API Ended Here *** //


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



