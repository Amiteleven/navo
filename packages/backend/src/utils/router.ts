import { Router as ExpressRouter, RequestHandler } from 'express';

/**
 * Express 4 does not await handler return values, so a rejected promise inside an
 * async handler becomes an unhandled rejection (which terminates the process)
 * instead of reaching the error-handling middleware. Wrapping every handler so
 * rejections are forwarded to `next()` keeps failures as normal 4xx/5xx
 * responses.
 */
const wrap = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    try {
      const result = (handler as unknown as (...args: unknown[]) => unknown)(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use'] as const;

export const Router = (): ExpressRouter => {
  const router = ExpressRouter();

  for (const method of METHODS) {
    const original = (router[method] as unknown as (...args: unknown[]) => unknown).bind(router);

    (router as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const last = args[args.length - 1];

      if (typeof last === 'function' || Array.isArray(last)) {
        const handlers = (Array.isArray(last) ? last : [last]) as RequestHandler[];
        args[args.length - 1] = handlers.map(wrap);
      }

      return original(...args);
    };
  }

  return router;
};

export default Router;
