import { Router } from "express";
import { isAuth, isSeller } from "@foodo/backend-common";
import { addRestaurant, getMyRestaurant, updateRestaurantDetails, updateRestaurantStatus, getAllRestaurants, getNearbyRestaurants, getRestaurantById } from "../controllers/restaurant.js";
import { getRestaurantImageSignature } from "../controllers/upload.js";

const router = Router()

// ── Public Routes (no auth required) ────────────────────────
router.get('/all', getAllRestaurants)
router.get('/nearby', getNearbyRestaurants)

// ── Auth-protected: /my must come BEFORE /:id wildcard ─────
router.get('/my', isAuth, isSeller, getMyRestaurant)

// Signed direct-upload: client fetches params here, then POSTs the file
// straight to Cloudinary. Auth-checked; folder is fixed server-side.
router.get('/upload-signature', isAuth, isSeller, getRestaurantImageSignature)

// ── Public wildcard (last to avoid catching /my, /all, etc.) ─
router.get('/:id', getRestaurantById)

// ── Seller-only Routes ─────────────────────────────────────
router.use(isAuth, isSeller);

router.post('/new', addRestaurant)
router.put('/update', updateRestaurantDetails)
router.put('/status', updateRestaurantStatus)

export {router as restaurantRouter}