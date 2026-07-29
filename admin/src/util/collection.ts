import connectDB from "../config/db.js";

let dbInstance:any = null;

const getDB = async () => {
    if (!dbInstance) {
        dbInstance = await connectDB();
    }
    return dbInstance;
};

export const getCollection = async (name:string) => {
    const db = await getDB();
    return db.collection(name);
};

export const getRestaurantCollection = () => getCollection("restaurants");
export const getUserCollection       = () => getCollection("users");
export const getOrderCollection      = () => getCollection("orders");
export const getRidersCollection     = () => getCollection("riders");