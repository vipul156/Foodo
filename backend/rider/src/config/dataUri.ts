import DataURIParser from "datauri/parser.js";
import path from "path";

const parser = new DataURIParser();

export const dataUri = (file: Express.Multer.File) => {
  return parser.format(
    path.extname(file.originalname).toString(),
    file.buffer
  );
};