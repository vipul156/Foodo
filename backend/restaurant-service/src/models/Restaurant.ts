import { Schema, Document, model } from "mongoose";

interface IRestaurant extends Document {
  name: string;
  description: string;
  image: string,
  ownerId: string;
  phone: number;
  isVerified: boolean;

  autoLocation: {
    type: 'Point',
    coordinates: [number, number];
    formattedAddress: string;
  },
  isOpen: boolean;
}

const restaurantSchema = new Schema<IRestaurant>({
  name: { type: String, required: true, trim: true },
  description: { type: String },
  image: {type:String},
  ownerId: {type:String, required: true},
  phone: {type:Number, required: true},
  isVerified: {type:Boolean, default: false},
  autoLocation: {
    type: {type:String, enum:['Point'], required: true},
    coordinates: {type:[Number], required: true},
    formattedAddress: {type:String, required: true}
  },
  isOpen: {type:Boolean, default: false},
},{
    timestamps: true
});

restaurantSchema.index({ "autoLocation": "2dsphere" });

export const Restaurant = model<IRestaurant>("Restaurant", restaurantSchema);
