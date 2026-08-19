// ============================================================
// Foodo — Global TypeScript Type Definitions
// Generated from backend microservice models
// ============================================================

// ─── Auth ────────────────────────────────────────────────────

export type UserRole = "customer" | "seller" | "rider" | "admin";

export interface IUser {
  _id: string;
  name: string;
  email: string;
  password?: string;
  role: UserRole;
  image?: string;
  restaurantId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IAuthResponse {
  message: string;
  user: IUser;
  token?: string;
}

export interface ILoginPayload {
  email: string;
  password: string;
}

export interface IRegisterPayload {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  image?: string;
}

// ─── Restaurant ──────────────────────────────────────────────

export interface IRestaurant {
  _id: string;
  name: string;
  description?: string;
  image?: string;
  ownerId: string;
  phone: number;
  isVerified: boolean;
  autoLocation: IGeoLocation;
  isOpen: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface IGeoLocation {
  type: "Point";
  coordinates: [number, number]; // [longitude, latitude]
  formattedAddress: string;
}

export interface IUpdateRestaurantPayload {
  name?: string;
  description?: string;
  phone?: number;
}

// ─── Menu Item ───────────────────────────────────────────────

export interface IMenuItem {
  _id: string;
  restaurantId: string;
  name: string;
  description: string;
  price: number;
  category?: string;
  image: string;
  isAvailable: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ICreateMenuItemPayload {
  name: string;
  description: string;
  price: number;
  image?: File;
}

// ─── Cart ────────────────────────────────────────────────────

export interface ICartItem {
  _id: string;
  userId: string;
  restaurantId: string | IRestaurant;
  itemId: string | IMenuItem;
  quantity: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ICartResponse {
  success: boolean;
  cart: ICartItem[];
  subtotal: number;
  cartLength: number;
}

// ─── Address ─────────────────────────────────────────────────

export interface IAddress {
  _id: string;
  userId: string;
  mobile: number;
  formatterAddress: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface ICreateAddressPayload {
  mobile: string;
  formatterAddress: string;
  latitude: number;
  longitude: number;
}

// ─── Order ───────────────────────────────────────────────────

export type OrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "ready_for_rider"
  | "rider_assigned"
  | "picked_up"
  | "delivered"
  | "cancelled";

export type PaymentMethod = "razorpay" | "stripe" | "cod";
export type PaymentStatus = "pending" | "paid" | "failed";

export interface IOrderItem {
  itemId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface IDeliveryAddress {
  formattedAddress: string;
  mobile: number;
  latitude: number;
  longitude: number;
}

export interface IOrder {
  _id: string;
  userId: string;
  restaurantId: string;
  restaurantName: string;
  riderId?: string | null;
  riderName?: string | null;
  riderPhone?: number | null;
  distance: number;
  riderAmount: number;
  items: IOrderItem[];
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;
  addressId: string;
  deliveryAddress: IDeliveryAddress;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  expiresAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ICreateOrderPayload {
  addressId: string;
  paymentMethod: PaymentMethod;
  distance: number;
}

// ─── Rider ───────────────────────────────────────────────────

export interface IRider {
  _id: string;
  userId: string;
  picture: string;
  phoneNumber: string;
  addharNumber: string;
  drivingLicenseNumber: string;
  isVerified: boolean;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
  isAvailable: boolean;
  lastActive: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ICreateRiderPayload {
  phoneNumber: string;
  addharNumber: string;
  drivingLicenseNumber: string;
  latitude: number;
  longitude: number;
}

// ─── Admin ───────────────────────────────────────────────────

export interface IPendingRestaurant {
  _id: string;
  name: string;
  description?: string;
  image?: string;
  ownerId: string;
  phone: number;
  isVerified: boolean;
  isOpen: boolean;
}

export interface IPendingRider {
  _id: string;
  userId: string;
  picture: string;
  phoneNumber: string;
  isVerified: boolean;
  isAvailable: boolean;
}

// ─── API Response Wrappers ───────────────────────────────────

export interface IApiResponse<T = unknown> {
  message?: string;
  success?: boolean;
  data?: T;
  count?: number;
  error?: string;
}

export interface IPaginatedResponse<T> {
  success: boolean;
  count: number;
  data: T[];
}

// ─── Socket Events ───────────────────────────────────────────

export interface ISocketOrderUpdate {
  orderId: string;
  status: OrderStatus;
}

export interface ISocketRiderAssigned {
  order: IOrder;
}
