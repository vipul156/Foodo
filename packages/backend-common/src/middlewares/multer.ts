import multer from "multer";
import type { RequestHandler } from "express";

// Memory storage: files are held in RAM as Buffers, converted to data URIs
// by the caller, and forwarded to utils-service for Cloudinary upload.
const storage = multer.memoryStorage();

// Cast: @types/multer@2 still pins @types/express@4 internally, so its
// inferred RequestHandler is not assignable to Express-5's RequestHandler.
// Runtime behavior is identical; the cast keeps the exported type portable.
const uploadFile = multer({ storage }).single("file") as unknown as RequestHandler;

export { uploadFile };
