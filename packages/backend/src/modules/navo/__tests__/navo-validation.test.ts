import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../../utils/errors.js';

const limitOffsetSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().positive().max(100).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
  }),
});

const requestIdParam = z.object({
  params: z.object({ requestId: z.string().min(1, 'Request ID is required') }),
});

const decisionSchema = z.object({
  body: z.object({
    decision: z.enum(['APPROVED', 'REJECTED', 'CHANGES_REQUESTED']),
    comments: z.string().max(2000).optional(),
  }),
});

function validateOrThrow(schema: z.ZodSchema, input: unknown): void {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(JSON.stringify(result.error.format()));
  }
}

describe('Navo: Route Validation', () => {
  it('limit is capped at 100', () => {
    const result = limitOffsetSchema.safeParse({ query: { limit: '200', offset: '0' } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].code).toBe('too_big');
  });

  it('limit must be positive', () => {
    const result = limitOffsetSchema.safeParse({ query: { limit: '0', offset: '0' } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].code).toBe('too_small');
  });

  it('limit must be an integer', () => {
    const result = limitOffsetSchema.safeParse({ query: { limit: '1.5', offset: '0' } });
    expect(result.success).toBe(false);
  });

  it('offset must be non-negative', () => {
    const result = limitOffsetSchema.safeParse({ query: { limit: '20', offset: '-1' } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].code).toBe('too_small');
  });

  it('limit defaults to 20 when not provided', () => {
    const result = limitOffsetSchema.parse({ query: {} });
    expect(result.query.limit).toBe(20);
    expect(result.query.offset).toBe(0);
  });

  it('requestId must not be empty', () => {
    const result = requestIdParam.safeParse({ params: { requestId: '' } });
    expect(result.success).toBe(false);
  });

  it('requestId with valid value passes', () => {
    const result = requestIdParam.safeParse({ params: { requestId: 'req-123' } });
    expect(result.success).toBe(true);
  });

  it('invalid decision value is rejected', () => {
    const result = decisionSchema.safeParse({ body: { decision: 'INVALID' } });
    expect(result.success).toBe(false);
  });

  it('valid decision value passes', () => {
    const result = decisionSchema.safeParse({ body: { decision: 'APPROVED', comments: 'looks good' } });
    expect(result.success).toBe(true);
  });

  it('decision without comments passes', () => {
    const result = decisionSchema.safeParse({ body: { decision: 'REJECTED' } });
    expect(result.success).toBe(true);
  });

  it('comments exceeding 2000 chars are rejected', () => {
    const result = decisionSchema.safeParse({ body: { decision: 'APPROVED', comments: 'x'.repeat(2001) } });
    expect(result.success).toBe(false);
  });
});
