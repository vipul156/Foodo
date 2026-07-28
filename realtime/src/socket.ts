import { Server } from "socket.io";
import http from "http";
import jwt from "jsonwebtoken";

let io:Server

export const initSocket = (server:http.Server) => {
    io = new Server(server, {
        cors: {
            origin: "*",
        },
    });

    io.use((socket, next) => {
        try{
            const token = socket.handshake.auth.token;
            
            if(!token){
                return next(new Error("Authentication error"));
            }

            const decode = jwt.verify(token, process.env.JWT_SECRET!) as any;

            if(!decode){
                return next(new Error("Authentication error"));
            }

            // Support both JWT formats:
            // 1. Auth service: { id, email, role } — no .user wrapper
            // 2. Restaurant service: { user: { ...user, restaurantId } }
            const userData = decode.user || decode;

            // Normalize: auth service uses 'id', others use '_id'
            const userId = userData._id || userData.id;
            if (!userId) {
                return next(new Error("Authentication error"));
            }

            socket.data.user = { ...userData, _id: userId };
            next();
        }catch(error:any){
            next(error);
        }
    });
    io.on("connection", (socket) => {
        const user = socket.data.user;
        if(!user){
            socket.disconnect();
            return;
        }
        
        const userId = user._id;
        
        socket.join(`user:${userId}`);

        if(user.restaurantId){
            socket.join(`restaurant:${user.restaurantId}`);
        }

        socket.on("disconnect", () => {
            console.log("User disconnected", user);
        });


    });
    return io
}

export const getIo = () => {
    if(!io){
        throw new Error("Socket.io not initialized");
    }
    return io;
}
