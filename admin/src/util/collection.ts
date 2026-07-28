import connectDB from "../config/db.js";

export const getRestaurantCollection = async () => {
    const db = await connectDB();
    return db.collection("restaurants");
}

export const getUserCollection = async () => {
    const db = await connectDB();
    return db.collection("users");
}

export const getOrderCollection = async () => {
    const db = await connectDB();
    return db.collection("orders");
}

export const getRidersCollection = async () => {
    const db = await connectDB();
    return db.collection("riders");
}
