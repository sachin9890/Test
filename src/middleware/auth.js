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
  const [scheme, token] = header.split(" ");
  const expected = process.env.API_TOKEN;

  if (scheme !== "Bearer" || !token || !expected || !safeEqual(token, expected)) {
    return next(new HttpError(401, "Missing or invalid bearer token"));
  }

  next();
}
