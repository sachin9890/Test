import { HttpError } from "../httpError.js";

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err instanceof HttpError ? err.status : 500;

  if (status === 500) {
    console.error(err);
  }

  res.status(status).json({
    error: err.message || "Internal server error",
    ...(err instanceof HttpError && err.details ? { details: err.details } : {}),
  });
}
