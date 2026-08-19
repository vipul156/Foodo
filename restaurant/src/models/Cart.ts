import mongoose from "mongoose";

export interface ICart {
    userId: mongoose.Types.ObjectId;
    restaurantId: mongoose.Types.ObjectId;
    itemId: mongoose.Types.ObjectId;
    quantity: number;
    createdAt: Date;
    updatedAt: Date;
}

const cartSchema = new mongoose.Schema<ICart>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },
    restaurantId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Restaurant",
        required: true,
        index: true
    },
    itemId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MenuItem",
        required: true,
        index: true
    },
    quantity: {
        type: Number,
        required: true,
        min: 1,
        default: 1
    },
}, {
    timestamps: true
});

cartSchema.index({ userId: 1, restaurantId: 1, itemId: 1 }, { unique: true });

export const Cart = mongoose.model<ICart>("Cart", cartSchema);
