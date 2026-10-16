import DataURIParser from "datauri/parser.js";
import path from "path";

// ─── Multer buffer → data URI ────────────────────────────────
// Converts a memory-storage multer file into a base64 data URI for the
// server-side Cloudinary upload fallback.

const parser = new DataURIParser();

export const dataUri = (file: Express.Multer.File) => {
  return parser.format(path.extname(file.originalname).toString(), file.buffer);
};
