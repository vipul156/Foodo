import { AuthRequest } from "@foodo/backend-common";
import { tryCatch } from "@foodo/backend-common";
import {
  createAddress,
  getAddress,
  listAddresses,
  deleteAddress as deleteAddressRow,
} from "../dynamo/cart.js";

export const createAddressController = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) {
      throw new Error("User not found");
    }

    const { mobile, formatterAddress, latitude, longitude } = req.body;

    if (!mobile || !formatterAddress) {
      throw new Error("Mobile and address are required");
    }

    if (latitude == null || longitude == null) {
      throw new Error("Location coordinates are required");
    }

    const newAddress = await createAddress({
      userId: String(user._id),
      mobile,
      formatterAddress,
      location: {
        type: "Point",
        coordinates: [Number(longitude), Number(latitude)],
      },
    });

    return res.status(201).json({
      success: true,
      message: "Address created successfully",
      data: newAddress,
    });
  },
);

export const deleteAddressController = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) {
      throw new Error("User not found");
    }

    const id = req.params.id as string;

    if (!id) {
      throw new Error("Address ID is required");
    }

    const address = await getAddress(String(user._id), id);
    if (!address) {
      throw new Error("Address not found");
    }

    await deleteAddressRow(String(user._id), id);

    return res.status(200).json({
      success: true,
      message: "Address deleted successfully",
    });
  },
);

export const getMyAddresses = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("User not found");
  }

  const addresses = await listAddresses(String(user._id));

  return res.status(200).json({
    success: true,
    data: addresses,
  });
});
