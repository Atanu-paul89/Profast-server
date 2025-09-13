# 🛡️ Profast Server — Backend API

This is the backend API for **Profast**, a smart logistics platform built to support parcel tracking, merchant operations, rider workflows, and admin analytics. Built with **Express.js** and **MongoDB**, it powers secure, scalable data flows across the Profast ecosystem.

---

## 🌐 Live Server

> 🔗 Hosted on: Vercel  
> 🧪 API testing via Postman or browser tools

---

## 📦 Core Features

- 🔐 JWT-based authentication and role protection  
- 📦 Parcel creation, tracking, and status updates  
- 💰 Payment logging and fare calculation  
- 🚴 Rider application and performance tracking  
- 🧑‍💼 Merchant dashboard data  
- 📊 Admin analytics and system logs  
- 🧠 Middleware for route protection and error handling

---

## 📡 API Endpoints Overview

### 🔹 Auth & Users

```http
POST /auth/register
POST /auth/login
GET /users/:email
PATCH /users/restrict/:id

🔹 Parcels
POST /parcels/create
GET /parcels/user/:email
PATCH /parcels/status/:id
GET /parcels/tracking/:trackingId

🔹 Payments
POST /payments/log
GET /payments/user/:email
GET /payments/stats

🔹 Rider
POST /rider/apply
GET /rider/performance/:email
PATCH /rider/approve/:id

🔹 Admin & Analytics
GET /admin/user-stats
GET /admin/system-logs
GET /admin/parcel-summary

---

🔐 Security Highlights
- JWT Authentication: Secures all protected routes
- Role-Based Access: Admin-only endpoints for sensitive operations
- Input Validation: Ensures clean and safe data flow
- Error Handling: Centralized error responses for debugging and logging
- CORS Enabled: For frontend-backend communication

---

⚙️ Installation & Setup
git clone https://github.com/Atanu-paul89/Profast-server.git
cd Profast-server
npm install

# Create a .env file with:
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret

#Start the server:
npm run dev

---

📁 Folder Structure
Profast-server/
├── index.js              # Main server entry point
└── .env                  # Environment variables

---

🧠 Developer Notes
- Modular route structure for scalability
- Uses MongoDB collections: users, parcels, payments, logs
- Designed to integrate seamlessly with Profast frontend
- All timestamps are stored in ISO format for consistency
- Admin dashboard pulls aggregated data from multiple collections
