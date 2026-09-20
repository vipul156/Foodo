import axios from "axios";

// All inter-service HTTP gets a hard timeout — a hung downstream service
// must never hang the upstream request thread indefinitely. Used for the
// calls that legitimately stay synchronous (reads, guards, uploads).
const http = axios.create({
  timeout: Number(process.env.INTERNAL_HTTP_TIMEOUT_MS) || 5000,
});

export default http;
