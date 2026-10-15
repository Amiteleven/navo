import { z } from 'zod';

/**
 * All primary keys in the Prisma schema are generated with `cuid()`, not `uuid()`.
 * Validating them with `z.string().uuid()` rejects every real record ID, so ID
 * fields are validated as non-empty strings instead.
 */
export const idSchema = z.string().min(1, 'Invalid ID');
