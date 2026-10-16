import { Router } from "express";
import { isAuth } from "@foodo/backend-common";
import { createAddressController, deleteAddressController, getMyAddresses } from "../controllers/address.js";

const router = Router();

router.use(isAuth)

router.post("/new",createAddressController)
router.delete("/:id", deleteAddressController)
router.get("/all",getMyAddresses)

export {router as addressRoute}