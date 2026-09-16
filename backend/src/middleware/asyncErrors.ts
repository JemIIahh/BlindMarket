/**
 * Express 4 does not forward a rejected promise from an `async` route handler
 * to the error middleware. The rejection escapes as an unhandledRejection, and
 * Node 22's default (--unhandled-rejections=throw) turns that into a process
 * exit — one request takes the whole API down until the host restarts it.
 *
 * Reproduced 2026-09-16 against production's code: `POST /api/v1/api-keys`
 * with an empty body (AppError thrown in the handler) and the same route with
 * no DATABASE_URL both exited the process. 22 async handlers had no try/catch.
 *
 * This patch makes every Express router forward async errors to `next(err)`,
 * so globalErrorHandler answers them like any other error. Import it once,
 * before the app and routers are built (index.ts and vercel.ts do).
 */
import 'express-async-errors';
