import { Schema, Document, model } from "mongoose";

export interface IAddress extends Document{
    userId: string;
    mobile:  number;

    formatterAddress: string;

    location:{
        type: "Point",
        coordinates: [number, number]
    }

    createdAt: Date;
    updatedAt: Date;
}

const addressSchema = new Schema<IAddress>({
    userId: {
        type: String,
        required: true,
    },
    mobile: {
        type: Number,
        required: true,
    },
    formatterAddress: {
        type: String,
        required: true,
    },
    location:{
        type:{
            type: String,
            enum: ["Point"],
            default: "Point",
        },
        coordinates:{
            type:[Number],
            required: true
        }
    }
},{
    timestamps: true
})

addressSchema.index({location: "2dsphere"})

export const Address = model<IAddress>("Address",addressSchema)