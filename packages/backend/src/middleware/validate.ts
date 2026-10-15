import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError, ZodTypeAny } from 'zod';
import { ValidationError } from '../utils/errors';

const WRAPPER_KEYS = ['body', 'query', 'params'] as const;

const isZodType = (value: unknown): value is ZodTypeAny =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ZodTypeAny).safeParseAsync === 'function';

/**
 * A schema is treated as request-scoped when every one of its top-level keys is
 * one of body/query/params and holds a Zod schema, e.g.
 *   z.object({ params: z.object({ id: z.string() }), body: z.object({ ... }) })
 * Anything else is treated as a plain req.body schema.
 */
const isRequestScopedSchema = (schema: AnyZodObject): boolean => {
  const entries = Object.entries(schema.shape as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, value]) => (WRAPPER_KEYS as readonly string[]).includes(key) && isZodType(value)
  );
};

const assignQuery = (req: Request, value: unknown): void => {
  const target = req as unknown as Record<string, unknown>;
  // Express 4 defines req.query as a configurable getter-only own property,
  // so a plain assignment throws in strict mode.
  delete target.query;
  target.query = value;
};

export const validate = (schema: AnyZodObject) =>
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (isRequestScopedSchema(schema)) {
        for (const key of WRAPPER_KEYS) {
          const subSchema = (schema.shape as Record<string, unknown>)[key];
          if (!subSchema) continue;

          const value = req[key] ?? ({} as Record<string, unknown>);
          const parsed = await (subSchema as AnyZodObject).parseAsync(value);

          if (key === 'query') {
            assignQuery(req, parsed);
          } else if (key === 'params') {
            req.params = parsed as Request['params'];
          } else {
            req.body = parsed;
          }
        }
      } else {
        req.body = await schema.parseAsync(req.body);
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details: Record<string, string[]> = {};
        error.errors.forEach((e) => {
          const path = e.path.join('.');
          if (!details[path]) details[path] = [];
          details[path].push(e.message);
        });
        return next(new ValidationError('Validation failed', details));
      }
      next(error);
    }
  };
