import { MongoClient, Db } from "mongodb";

let client: MongoClient
let db: Db

const connectDB = async (): Promise<Db> => {
    try {
        if(db) return db;

        client = new MongoClient(process.env.MONGO_URI!);
        await client.connect();

        db = client.db(process.env.DB_NAME)
        console.log("MongoDB connected");

        return db;
    } catch (error) {
        console.log(error);
        process.exit(1);
    }
};

export default connectDB;