import { Router } from "express";
import { isAuth, isSeller } from "../middlewares/isAuth.js";
import { addRestaurant, getMyRestaurant, updateRestaurantDetails, updateRestaurantStatus } from "../controllers/restaurant.js";

const router = Router()

router.use(isAuth, isSeller);

router.post('/new', addRestaurant)
router.get('/my', getMyRestaurant)
router.put('/update', updateRestaurantDetails)
router.put('/status', updateRestaurantStatus)

export {router as restaurantRouter}