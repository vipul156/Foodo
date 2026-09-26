import mongoose, { Schema, Document, model } from "mongoose";

export interface IMenuItem extends Document {
  restaurantId: mongoose.Types.ObjectId;
  name: string;
  description: string;
  price: number;
  category: string;
  image: string;
  isAvailable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const menuItemSchema = new Schema<IMenuItem>(
  {
    restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true},
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    price: { type: Number, required: true },
    image: { type: String, required: true },
    isAvailable: { type: Boolean, required: true, default: true },
  },
  {
    timestamps: true,
  },
);

export const MenuItem = model<IMenuItem>("MenuItem", menuItemSchema);
