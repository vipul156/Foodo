import { Router } from "express";
import { isAuth, isSeller } from "../middlewares/isAuth.js";
import { addRestaurant, getMyRestaurant, updateRestaurantDetails, updateRestaurantStatus, getAllRestaurants, getNearbyRestaurants, getRestaurantById } from "../controllers/restaurant.js";

const router = Router()

// ── Public Routes (no auth required) ────────────────────────
router.get('/all', getAllRestaurants)
router.get('/nearby', getNearbyRestaurants)
router.get('/:id', getRestaurantById)

// ── Seller-only Routes ─────────────────────────────────────
router.use(isAuth, isSeller);

router.post('/new', addRestaurant)
router.get('/my', getMyRestaurant)
router.put('/update', updateRestaurantDetails)
router.put('/status', updateRestaurantStatus)

export {router as restaurantRouter}