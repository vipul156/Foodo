import { Server } from "socket.io";
import http from "http";
import jwt from "jsonwebtoken";

let io:Server

// ─── Browser origin allow-list ─────────────────────────────
// Socket connections are cross-origin (the browser talks to this
// service directly, not through the frontend's own origin), so CORS
// actually applies — unlike the service APIs, which the ALB serves
// same-origin. Origins come from SOCKET_CORS_ORIGIN (comma-separated
// to allow several environments) and fall back to FRONTEND_URL.
// Never default to "*": an open websocket would let any site open an
// authenticated socket once a visitor's token leaks (handshake auth
// travels in the request).
const getAllowedOrigins = (): string[] =>
  (
    process.env.SOCKET_CORS_ORIGIN ||
    process.env.FRONTEND_URL ||
    "http://localhost:3000"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

export const initSocket = (server:http.Server) => {
    const allowedOrigins = getAllowedOrigins();

    io = new Server(server, {
        cors: {
            origin: allowedOrigins,
            methods: ["GET", "POST"],
            credentials: true,
        },
    });

    console.log(
        `[Realtime] Socket CORS restricted to: ${allowedOrigins.join(", ")}`
    );

    io.use((socket, next) => {
        try{
            // Get JWT from socket.handshake.auth.token (standard Socket.IO auth)
            // The frontend passes this token after login/register.
            const jwtToken = socket.handshake.auth.token;

            if (!jwtToken) {
                return next(new Error("Authentication error"));
            }

            const decode = jwt.verify(jwtToken, process.env.JWT_SECRET!) as any;

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

        // ─── Live tracking rooms ─────────────────────────
        // Clients (customer/seller dashboards) join an order's tracking
        // room while a map is open, leave when it closes. NOTE: any
        // authenticated socket may join any order room — fine for the
        // demo, but production should verify ownership first.
        socket.on("order:track", (payload: { orderId?: string }) => {
            if (!payload?.orderId) return;
            socket.join(`order:${payload.orderId}`);
        });

        socket.on("order:untrack", (payload: { orderId?: string }) => {
            if (!payload?.orderId) return;
            socket.leave(`order:${payload.orderId}`);
        });

        // ─── Live rider location relay ─────────────────────
        // Riders stream position pings while delivering; the realtime
        // service fans them out to everyone tracking that order
        // (customer, seller, admin). Riders never receive them.
        // Payload: { orderId, latitude, longitude } — role-checked so a
        // customer socket can't spoof rider positions.
        socket.on("rider:location", (payload: {
            orderId?: string;
            latitude?: number;
            longitude?: number;
        }) => {
            if (user.role !== "rider") return;

            const { orderId, latitude, longitude } = payload ?? {};

            if (
                !orderId ||
                typeof latitude !== "number" ||
                typeof longitude !== "number" ||
                Number.isNaN(latitude) ||
                Number.isNaN(longitude)
            ) {
                return;
            }

            io.to(`order:${orderId}`).emit("rider:location", {
                orderId,
                latitude,
                longitude,
                at: Date.now(),
            });
        });

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
