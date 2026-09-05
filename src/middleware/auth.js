import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../httpError.js";

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function authMiddleware(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, headerToken] = header.split(" ");
  const expected = process.env.API_TOKEN;

  // Browsers' native EventSource can't set custom headers, so the SSE event stream
  // route also accepts the token as a query param. Documented tradeoff: it can end up
  // in server access logs. Every other route only accepts the Authorization header.
  const token = scheme === "Bearer" ? headerToken : req.query.token;

  if (!token || !expected || !safeEqual(String(token), expected)) {
    return next(new HttpError(401, "Missing or invalid bearer token"));
  }

  next();
}
