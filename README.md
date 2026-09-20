# 🍽️ Foodo — Multi-Role Food Delivery Platform

**Foodo** is a production-grade, microservice-based food delivery platform supporting four distinct user roles: **Customers**, **Restaurant Owners (Sellers)**, **Delivery Riders**, and **Platform Administrators**. The system follows a modular microservice architecture with a Next.js frontend and multiple Node.js/Express backend services.

---

## 📋 Table of Contents

- [Architecture Overview](#-architecture-overview)
- [System Requirements](#-system-requirements)
- [Services Overview](#-services-overview)
  - [1. Auth Service](#1-auth-service)
  - [2. Restaurant Service](#2-restaurant-service)
  - [3. Rider Service](#3-rider-service)
  - [4. Admin Service](#4-admin-service)
  - [5. Realtime Service](#5-realtime-service)
  - [6. Utils Service](#6-utils-service)
  - [7. Frontend](#7-frontend)
- [Service Communication](#-service-communication)
- [Database Schema Overview](#-database-schema-overview)
- [API Endpoints Reference](#-api-endpoints-reference)
- [Installation & Setup](#-installation--setup)
- [Running Locally](#-running-locally)
- [Environment Variables Reference](#-environment-variables-reference)
- [Tech Stack](#-tech-stack)

---

## 🏗 Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Customer │ │  Seller  │ │  Rider   │ │    Admin     │ │
│  │  Portal  │ │ Dashboard│ │   App    │ │ Control Panel│ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘ │
│       │             │            │               │         │
└───────┼─────────────┼────────────┼───────────────┼─────────┘
        │             │            │               │
        ▼             ▼            ▼               ▼
┌──────────────────────────────────────────────────────────┐
│         Microservice API Gateway (Direct HTTP calls)      │
│                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────┐  ┌──────────────┐   │
│  │  Auth    │ │Restaurant│ │Rider │  │    Admin     │   │
│  │ :3000    │ │ :3001    │ │:Port │  │    :Port     │   │
│  └────┬─────┘ └────┬─────┘ └──┬───┘  └──────┬───────┘   │
│       │            │          │              │           │
│       ▼            ▼          ▼              ▼           │
│  ┌──────────────────────────────────────────────────┐    │
│  │            MongoDB (Shared Database)              │   │
│  └──────────────────────────────────────────────────┘    │
│                                                           │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  RabbitMQ MQ   │  │   Realtime   │  │    Utils     │ │
│  │ (Event Queue)  │  │  Socket.IO   │  │(Payments,    │ │
│  │                │  │   :3002      │  │ Uploads)     │ │
│  └────────────────┘  └──────────────┘  │   :Port      │ │
│                                         └──────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

- **Microservices**: Each domain is a separate Node.js/Express service with its own responsibility.
- **JWT Authentication**: JSON Web Tokens for stateless auth across microservices.
- **Internal Service Keys**: Services communicate internally using shared `INTERNAL_SERVICE_KEY` headers.
- **RabbitMQ**: Async event-driven communication for order lifecycle events (ready for rider, payment updates).
- **Socket.IO**: Real-time push notifications to customers, sellers, and riders.
- **Shared MongoDB**: Services share a MongoDB database (collections separated by domain).

---

## 💻 System Requirements

| Tool | Version |
|------|---------|
| Node.js | >= 18 |
| npm | >= 9 |
| MongoDB | >= 6 |
| RabbitMQ | >= 3.12 |
| TypeScript | 6.x - 7.x (service-dependent) |

---

## 🔧 Services Overview

### 1. Auth Service

**Purpose**: User registration, login, and session management.

| Property | Value |
|----------|-------|
| Port | `3000` |
| TypeScript | `6.x` |
| Database | MongoDB (`auth` collections via Mongoose) |

**Dependencies**: `express`, `mongoose`, `jsonwebtoken`, `bcrypt`, `cookie-session`, `googleapis`

**Routes**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Register new user (roles: customer, rider, seller) |
| POST | `/api/auth/login` | No | Login with email/password |
| GET | `/api/auth/me` | JWT | Get current authenticated user |

**Auth Flow**: JWT token stored in `req.session` (cookie-session). Returns user data + sets session cookie. For cross-service auth, the frontend must pass the JWT in the `Authorization: Bearer <token>` header.

---

### 2. Restaurant Service

**Purpose**: Restaurant management, menu items, cart operations, and order management.

| Property | Value |
|----------|-------|
| Port | `3001` |
| TypeScript | `6.x` |
| Database | MongoDB (Mongoose) |
| Message Queue | RabbitMQ |

**Dependencies**: `express`, `mongoose`, `jsonwebtoken`, `amqplib`, `multer`, `datauri`, `axios`, `cookie-session`

**Restaurant Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/restaurant/new` | Seller | Create restaurant profile |
| GET | `/restaurant/my` | Seller | Get own restaurant details |
| PUT | `/restaurant/update` | Seller | Update restaurant details |
| PUT | `/restaurant/status` | Seller | Toggle open/closed status |

**Menu Item Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/menu-item/all/:id` | Auth | Get all menu items for a restaurant |
| POST | `/menu-item/new` | Seller | Create new menu item (multipart) |
| DELETE | `/menu-item/delete/:id` | Seller | Delete a menu item |
| PUT | `/menu-item/toggle/:id` | Seller | Toggle item availability |

**Cart Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/cart/add` | Auth | Add item to cart |
| GET | `/cart/all` | Auth | Get cart with subtotal |
| DELETE | `/cart/clear` | Auth | Clear entire cart |
| PUT | `/cart/increase` | Auth | Increment item quantity |
| PUT | `/cart/decrease` | Auth | Decrement item quantity |

**Order Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/order/new` | Auth | Create order from cart |
| GET | `/order/my` | Auth | Get my orders |
| GET | `/order/:orderId` | Auth | Get single order details |
| GET | `/order/order/:restaurantId` | Seller | Get restaurant orders |
| PUT | `/order/:orderId` | Seller | Update order status |
| GET | `/order/payment/:id` | Internal | Fetch order for payment processing |
| PUT | `/order/assign/rider` | Internal | Assign rider to order |
| GET | `/order/current/rider` | Internal | Get rider's current order |
| PUT | `/order/update/status/rider` | Internal | Rider updates delivery status |

**Address Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/address/new` | Auth | Create delivery address |
| GET | `/address/all` | Auth | Get all saved addresses |
| DELETE | `/address/:id` | Auth | Delete an address |

---

### 3. Rider Service

**Purpose**: Rider profile management, order acceptance, and delivery lifecycle.

| Property | Value |
|----------|-------|
| Port | `3003` (configurable via `PORT` env) |
| TypeScript | `7.x` |
| Database | MongoDB (Mongoose) |
| Message Queue | RabbitMQ |

**Dependencies**: `express`, `mongoose`, `jsonwebtoken`, `amqplib`, `multer`, `datauri`, `axios`

**Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/rider/new` | Rider | Create rider profile (multipart) |
| GET | `/rider/myprofile` | Rider | Get rider profile |
| PATCH | `/rider/toggle` | Rider | Toggle availability (with location) |
| POST | `/rider/accept/:orderId` | Rider | Accept a delivery order |
| GET | `/rider/order/current` | Rider | Get current active order |
| PUT | `/rider/order/update` | Rider | Update order delivery status |

**Order Flow for Riders**:
1. Restaurant marks order `ready_for_rider` → RabbitMQ event published
2. Rider service consumer picks up event → eligible riders notified
3. Rider accepts via `POST /rider/accept/:orderId`
4. Order status updates: `rider_assigned` → `picked_up` → `delivered`
5. Realtime events emitted to user room on each status change

---

### 4. Admin Service

**Purpose**: Platform administration, verification of restaurants and riders.

| Property | Value |
|----------|-------|
| Port | `3004` (default, configurable via `PORT` env) |
| TypeScript | `7.x` |
| Database | MongoDB (Native Driver) |

**Dependencies**: `express`, `mongodb` (native driver), `jsonwebtoken`, `cookie-session`

**Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/admin/restaurant/pending` | - | Get unverified restaurants |
| GET | `/api/admin/rider/pending` | - | Get unverified riders |
| PATCH | `/api/verify/rider/:id` | - | Approve/reject rider verification |
| PATCH | `/api/verify/restaurant/:id` | - | Approve/reject restaurant verification |

**Note**: Admin service directly accesses the restaurant and rider MongoDB collections using native MongoDB driver (not Mongoose).

---

### 5. Realtime Service

**Purpose**: WebSocket/Socket.IO server for real-time push notifications.

| Property | Value |
|----------|-------|
| Port | `3002` |
| TypeScript | `7.x` |

**Dependencies**: `express`, `socket.io`, `jsonwebtoken`

**Internal Endpoints**:
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/internal/emit` | Internal Key | Emit event to a room |

**Socket.IO Connection**:
- Connect with `auth: { token: <JWT> }` in handshake
- Auto-joins `user:<userId>` room
- Auto-joins `restaurant:<restaurantId>` room if user has `restaurantId`

**Events**:
- `order:update` — Order status changed
- `order:rider_assigned` — Rider assigned to order
- `order:delivered` — Order delivered

---

### 6. Utils Service

**Purpose**: Shared utilities — file uploads (Cloudinary) and payment processing (Razorpay, Stripe).

| Property | Value |
|----------|-------|
| Port | `3005` (configurable via `PORT` env) |
| TypeScript | `6.x` |
| Message Queue | RabbitMQ |

**Dependencies**: `express`, `cloudinary`, `razorpay`, `stripe`, `jsonwebtoken`, `amqplib`

**Capabilities**:
- **Image Uploads**: Proxy uploads to Cloudinary (used by Restaurant & Rider services)
- **Payment Processing**: Razorpay and Stripe integration
- **RabbitMQ**: Event-driven payment confirmation → order fulfillment

---

### 7. Frontend

**Purpose**: Next.js 16 multi-role web application.

| Property | Value |
|----------|-------|
| Port | `3000` (Next.js dev server) |
| Framework | Next.js 16, React 19 |
| Styling | Tailwind CSS v4, Shadcn UI |
| State | TanStack Query, Zustand |

**Tech Stack**: `next`, `react`, `tailwindcss`, `shadcn`, `@tanstack/react-query`, `zustand`, `react-hook-form`, `zod`, `framer-motion`, `lucide-react`

**Routes**:
| Route | Role | Description |
|-------|------|-------------|
| `/` | Customer | Restaurant discovery homepage |
| `/login` | All | User login |
| `/register` | All | User registration with role selection |
| `/seller` | Seller | Restaurant owner dashboard |
| `/rider` | Rider | Delivery rider mobile interface |
| `/admin` | Admin | Platform admin control panel |

---

## 🔄 Service Communication

```
┌─────────────┐         ┌──────────────┐
│   Rider     │────────▶│  Restaurant  │
│  Service    │  HTTP   │   Service    │
│             │ (assign,│              │
│             │  status)│              │
└──────┬──────┘         └──────┬───────┘
       │                       │
       │  RabbitMQ             │  HTTP (Realtime)
       │  (order:ready)        │  (emit events)
       ▼                       ▼
┌──────────────┐       ┌──────────────┐
│   Realtime   │◀──────│  Restaurant  │
│   Service    │ HTTP  │   Service    │
│ (Socket.IO)  │       │              │
└──────────────┘       └──────────────┘
       │                       │
       │  Socket.IO            │  HTTP (Upload)
       ▼                       ▼
┌──────────────┐       ┌──────────────┐
│   Frontend   │──────▶│ Utils Service│
│  (Next.js)   │ HTTP  │  (Cloudinary)│
└──────────────┘       └──────────────┘
```

**Internal Communication**:
- Services authenticate inter-service calls via `x-internal-key` header matching `INTERNAL_SERVICE_KEY`
- RabbitMQ used for async events (order ready for rider, payment confirmation)
- Realtime service receives HTTP calls from Restaurant service to emit Socket.IO events

---

## 📊 Database Schema Overview

### Users (`auth` service)
```
User {
  _id: ObjectId
  name: String
  email: String (unique)
  password: String (bcrypt hashed)
  role: "customer" | "seller" | "rider"
  image: String (optional)
}
```

### Restaurants (`restaurant` service)
```
Restaurant {
  _id: ObjectId
  name: String
  description: String
  image: String
  ownerId: String (references User._id)
  phone: Number
  isVerified: Boolean
  isOpen: Boolean
  autoLocation: { type: "Point", coordinates: [lng, lat], formattedAddress }
}
```

### Menu Items (`restaurant` service)
```
MenuItem {
  _id: ObjectId
  restaurantId: ObjectId (ref: Restaurant)
  name: String
  description: String
  price: Number
  image: String
  isAvailable: Boolean
}
```

### Cart (`restaurant` service)
```
Cart {
  userId: ObjectId (ref: User) [indexed]
  restaurantId: ObjectId (ref: Restaurant) [indexed]
  itemId: ObjectId (ref: MenuItem) [indexed]
  quantity: Number (min: 1)
}
// Compound unique index: { userId, restaurantId, itemId }
```

### Orders (`restaurant` service)
```
Order {
  userId: String
  restaurantId: String
  restaurantName: String
  riderId: String | null
  riderName: String | null
  riderPhone: Number | null
  distance: Number
  riderAmount: Number
  items: [{ itemId, name, price, quantity }]
  subtotal: Number
  deliveryFee: Number
  platformFee: Number
  totalAmount: Number
  addressId: String
  deliveryAddress: { formattedAddress, mobile, latitude, longitude }
  status: "placed" | "accepted" | "preparing" | "ready_for_rider" | "rider_assigned" | "picked_up" | "delivered" | "cancelled"
  paymentMethod: "razorpay" | "stripe"
  paymentStatus: "pending" | "paid" | "failed"
  expiresAt: Date (TTL index)
}
```

### Addresses (`restaurant` service)
```
Address {
  userId: String
  mobile: Number
  formatterAddress: String
  location: { type: "Point", coordinates: [lng, lat] }
}
// 2dsphere index on location
```

### Riders (`rider` service)
```
Rider {
  userId: String (unique)
  picture: String
  phoneNumber: String (unique)
  addharNumber: String (unique)
  drivingLicenseNumber: String (unique)
  isVerified: Boolean
  isAvailable: Boolean
  location: { type: "Point", coordinates: [lng, lat] }
  lastActive: Date
}
// 2dsphere index on location
```

---

## 📡 API Endpoints Reference

### Full API Map

| Service | Method | Endpoint | Auth | Description |
|---------|--------|----------|------|-------------|
| **Auth** | POST | `/api/auth/register` | - | Register |
| **Auth** | POST | `/api/auth/login` | - | Login |
| **Auth** | GET | `/api/auth/me` | JWT | Get profile |
| **Restaurant** | POST | `/restaurant/new` | Seller | Create restaurant |
| **Restaurant** | GET | `/restaurant/my` | Seller | Get my restaurant |
| **Restaurant** | PUT | `/restaurant/update` | Seller | Update restaurant |
| **Restaurant** | PUT | `/restaurant/status` | Seller | Toggle open/closed |
| **Restaurant** | GET | `/menu-item/all/:id` | Auth | List menu items |
| **Restaurant** | POST | `/menu-item/new` | Seller | Create item |
| **Restaurant** | DELETE | `/menu-item/delete/:id` | Seller | Delete item |
| **Restaurant** | PUT | `/menu-item/toggle/:id` | Seller | Toggle availability |
| **Restaurant** | POST | `/cart/add` | Auth | Add to cart |
| **Restaurant** | GET | `/cart/all` | Auth | Get cart |
| **Restaurant** | DELETE | `/cart/clear` | Auth | Clear cart |
| **Restaurant** | PUT | `/cart/increase` | Auth | Increase qty |
| **Restaurant** | PUT | `/cart/decrease` | Auth | Decrease qty |
| **Restaurant** | POST | `/order/new` | Auth | Create order |
| **Restaurant** | GET | `/order/my` | Auth | My orders |
| **Restaurant** | GET | `/order/:orderId` | Auth | Order detail |
| **Restaurant** | GET | `/order/order/:restaurantId` | Seller | Restaurant orders |
| **Restaurant** | PUT | `/order/:orderId` | Seller | Update status |
| **Restaurant** | GET | `/order/payment/:id` | Internal | Payment fetch |
| **Restaurant** | PUT | `/order/assign/rider` | Internal | Assign rider |
| **Restaurant** | GET | `/order/current/rider` | Internal | Rider's current order |
| **Restaurant** | PUT | `/order/update/status/rider` | Internal | Rider status update |
| **Restaurant** | POST | `/address/new` | Auth | Create address |
| **Restaurant** | GET | `/address/all` | Auth | Get addresses |
| **Restaurant** | DELETE | `/address/:id` | Auth | Delete address |
| **Admin** | GET | `/api/admin/restaurant/pending` | - | Pending restaurants |
| **Admin** | GET | `/api/admin/rider/pending` | - | Pending riders |
| **Admin** | PATCH | `/api/verify/rider/:id` | - | Verify rider |
| **Admin** | PATCH | `/api/verify/restaurant/:id` | - | Verify restaurant |
| **Rider** | POST | `/rider/new` | Rider | Create rider profile |
| **Rider** | GET | `/rider/myprofile` | Rider | Get profile |
| **Rider** | PATCH | `/rider/toggle` | Rider | Toggle availability |
| **Rider** | POST | `/rider/accept/:orderId` | Rider | Accept order |
| **Rider** | GET | `/rider/order/current` | Rider | Current order |
| **Rider** | PUT | `/rider/order/update` | Rider | Update status |
| **Realtime** | POST | `/api/v1/internal/emit` | Internal | Emit socket event |

---

## 🚀 Installation & Setup

### Prerequisites

Make sure the following are installed and running:
1. **Node.js** >= 18
2. **MongoDB** (local or Atlas)
3. **RabbitMQ** (for event-driven features)
4. **npm** >= 9

### Clone the Repositories

Each service is a separate repository/path under the `Foodo/` directory:

```
Foodo/
├── auth/          # Auth microservice
├── restaurant/    # Restaurant microservice
├── rider/         # Rider microservice
├── admin/         # Admin microservice
├── realtime/      # Socket.IO realtime service
├── utils/         # Shared utilities (uploads, payments)
└── frontend/      # Next.js web application
```

### Quick Setup (All Services)

Run these commands from the `Foodo/` root for each service:

```bash
# Navigate to each service directory and install
cd auth && npm install && cd ..
cd restaurant && npm install && cd ..
cd rider && npm install && cd ..
cd admin && npm install && cd ..
cd realtime && npm install && cd ..
cd utils && npm install && cd ..
cd frontend && npm install && cd ..
```

---

## 🏃 Running Locally

### 1. Start Infrastructure

```bash
# Start MongoDB
mongod

# Start RabbitMQ
rabbitmq-server
```

### 2. Configure Environment Variables

Each service requires a `.env` file. Create one in each service directory. Below are the required variables:

#### Auth Service `.env`
```env
PORT=3000
MONGO_URI=mongodb://localhost:27017/foodo
JWT_SECRET=your-jwt-secret-key
COOKIE_SECRET=your-cookie-secret
```

#### Restaurant Service `.env`
```env
PORT=3001
MONGO_URI=mongodb://localhost:27017/foodo
JWT_SECRET=your-jwt-secret-key
COOKIE_SECRET=your-cookie-secret
UTILS_SERVICE_URL=http://localhost:PORT
REALTIME_SERVICE_URL=http://localhost:3002
INTERNAL_SERVICE_KEY=your-internal-service-key
RABBITMQ_URL=amqp://localhost
```

#### Rider Service `.env`
```env
PORT=3003
MONGO_URI=mongodb://localhost:27017/foodo
JWT_SECRET=your-jwt-secret-key
RESTAURANT_SERVICE=http://localhost:3001
INTERNAL_SERVICE_KEY=your-internal-service-key
RABBITMQ_URL=amqp://localhost
UTILS_SERVICE_URL=http://localhost:PORT
```

#### Admin Service `.env`
```env
PORT=3006
JWT_SECRET=your-jwt-secret-key
COOKIE_SECRET=your-cookie-secret
AUTH_SERVICE_URL=http://localhost:3001
RESTAURANT_SERVICE_URL=http://localhost:3003
RIDER_SERVICE_URL=http://localhost:3004
INTERNAL_SERVICE_KEY=your-internal-service-key
```

#### Realtime Service `.env`
```env
PORT=3002
JWT_SECRET=your-jwt-secret-key
INTERNAL_SERVICE_KEY=your-internal-service-key
RABBITMQ_URL=amqp://localhost
# Optional overrides — defaults are order.status_changed / realtime.emit
# REALTIME_EXCHANGE=order.status_changed
# REALTIME_QUEUE=realtime.emit
```

#### Utils Service `.env`
```env
PORT=3005
MONGO_URI=mongodb://localhost:27017/foodo
JWT_SECRET=your-jwt-secret-key
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
RAZORPAY_KEY_ID=your-razorpay-key
RAZORPAY_KEY_SECRET=your-razorpay-secret
STRIPE_SECRET_KEY=your-stripe-secret
RABBITMQ_URL=amqp://localhost
INTERNAL_SERVICE_KEY=your-internal-service-key
```

#### Frontend `.env.local`
```env
NEXT_PUBLIC_AUTH_SERVICE_URL=http://localhost:3000/api/auth
NEXT_PUBLIC_RESTAURANT_SERVICE_URL=http://localhost:3001
NEXT_PUBLIC_RIDER_SERVICE_URL=http://localhost:3003/rider
NEXT_PUBLIC_ADMIN_SERVICE_URL=http://localhost:3004/api
NEXT_PUBLIC_REALTIME_SERVICE_URL=http://localhost:3002
```

### 3. Start All Services

Open separate terminals for each service:

```bash
# Terminal 1 — Auth Service
cd auth && npm run dev

# Terminal 2 — Restaurant Service
cd restaurant && npm run dev

# Terminal 3 — Rider Service
cd rider && npm run dev

# Terminal 4 — Admin Service
cd admin && npm run dev

# Terminal 5 — Realtime Service
cd realtime && npm run dev

# Terminal 6 — Utils Service
cd utils && npm run dev

# Terminal 7 — Frontend
cd frontend && npm run dev
```

### 4. Open the Application

Visit [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🔐 Environment Variables Reference

| Variable | Services | Description |
|----------|----------|-------------|
| `PORT` | All | Service port number |
| `MONGO_URI` | Auth, Restaurant, Rider | MongoDB connection string |
| `JWT_SECRET` | Auth, Restaurant, Rider, Admin, Realtime | JWT signing secret |
| `COOKIE_SECRET` | Auth, Restaurant, Admin | Cookie session encryption key |
| `INTERNAL_SERVICE_KEY` | Restaurant, Rider, Realtime, Utils | Shared key for inter-service auth |
| `RABBITMQ_URL` | Restaurant, Rider, Utils | RabbitMQ connection URL |
| `UTILS_SERVICE_URL` | Restaurant, Rider | URL of the Utils microservice (e.g. `http://localhost:3005`) |
| `REALTIME_SERVICE_URL` | Restaurant | URL of the Realtime socket service (e.g. `http://localhost:3002`) |
| `RESTAURANT_SERVICE` | Rider | URL of the Restaurant microservice (e.g. `http://localhost:3001`) |
| `CLOUDINARY_*` | Utils | Cloudinary API credentials |
| `RAZORPAY_*` | Utils | Razorpay payment gateway keys |
| `STRIPE_SECRET_KEY` | Utils | Stripe payment secret |

---

## 🛠 Tech Stack

### Backend Services
| Technology | Purpose |
|------------|---------|
| **Node.js / Express** | HTTP server framework for all services |
| **TypeScript** 6.x–7.x | Type-safe JavaScript |
| **MongoDB + Mongoose** | Primary database with ODM |
| **MongoDB Native Driver** | Admin service direct DB access |
| **JWT (jsonwebtoken)** | Stateless authentication tokens |
| **bcrypt** | Password hashing |
| **cookie-session** | Session cookie management |
| **Socket.IO** | Real-time bidirectional communication |
| **RabbitMQ (amqplib)** | Async message queue for events |
| **Cloudinary** | Image upload and CDN |
| **Razorpay / Stripe** | Payment gateway integration |
| **Multer + DataUri** | File upload handling |

### Frontend
| Technology | Purpose |
|------------|---------|
| **Next.js 16** | React meta-framework with App Router |
| **React 19** | UI library |
| **Tailwind CSS v4** | Utility-first styling |
| **Shadcn UI** | Accessible component primitives (Radix-based) |
| **TanStack Query** | Server state management & caching |
| **Zustand** | Client-side global UI state |
| **React Hook Form + Zod** | Form validation |
| **Framer Motion** | Animation library |
| **Lucide React** | Icon library |
| **HugeIcons** | Additional icon set |

---

## 📁 Project Structure

```
auth/                     # Auth microservice
├── src/
│   ├── config/           # DB connection
│   ├── controllers/      # Route handlers
│   ├── middlewares/       # Auth middleware (JWT)
│   ├── models/           # Mongoose User model
│   └── routes/           # Auth routes
├── package.json
└── tsconfig.json

restaurant/               # Restaurant microservice
├── src/
│   ├── config/           # DB, RabbitMQ, DataUri
│   ├── controllers/      # Restaurant, Menu, Cart, Order, Address
│   ├── middlewares/       # Auth, Seller guards
│   ├── models/           # All Mongoose models
│   └── routes/           # All route definitions
├── package.json
└── tsconfig.json

rider/                    # Rider microservice
├── src/
│   ├── config/           # DB, RabbitMQ, DataUri
│   ├── controller/       # Rider CRUD, Order lifecycle
│   ├── middlewares/       # Auth, Rider guards
│   ├── model/            # Rider Mongoose model
│   └── routes/           # Rider routes
├── package.json
└── tsconfig.json

admin/                    # Admin microservice
├── src/
│   ├── config/           # DB connection
│   ├── controllers/      # Admin verification logic
│   ├── middlewares/       # Auth middleware
│   ├── routes/           # Admin API routes
│   └── util/             # Collection helpers
├── package.json
└── tsconfig.json

realtime/                 # Socket.IO realtime service
├── src/
│   ├── routes/           # Internal emit endpoint
│   └── socket.ts         # Socket.IO initialization & events
├── package.json
└── tsconfig.json

utils/                    # Shared utilities service
├── src/
│   ├── config/           # DB, Cloudinary
│   ├── controllers/      # Upload & Payment logic
│   ├── middlewares/       # Auth middleware
│   └── routers/          # Utility routes
├── package.json
└── tsconfig.json

frontend/                 # Next.js web application
├── src/
│   ├── app/              # App Router pages
│   │   ├── (auth)/       # Login, Register
│   │   ├── (customer)/   # Homepage
│   │   ├── admin/        # Admin panel
│   │   ├── rider/        # Rider dashboard
│   │   └── seller/       # Seller dashboard
│   ├── components/       # UI & shared components
│   ├── features/         # Feature modules (auth, orders, restaurants)
│   ├── hooks/            # Custom hooks
│   ├── lib/              # API client, utilities
│   ├── providers/        # TanStack Query, Toast
│   ├── store/            # Zustand stores
│   └── types/            # TypeScript definitions
├── package.json
└── next.config.ts
```

---

## 📜 License

This project is proprietary software. All rights reserved.

---

## 🤝 Contributing

1. Ensure all services are running locally
2. Create a feature branch from `master`
3. Make changes following the existing architecture patterns
4. Test against the relevant API endpoints
5. Submit a pull request with a clear description of changes
