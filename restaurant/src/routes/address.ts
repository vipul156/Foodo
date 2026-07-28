import { Router } from "express";
import { isAuth } from "../middlewares/isAuth.js";
import { createAddress, deleteAddress, getMyAddresses } from "../controllers/address.js";

const router = Router();

router.use(isAuth)

router.post("/new",createAddress)
router.delete("/:id", deleteAddress)
router.get("/all",getMyAddresses)