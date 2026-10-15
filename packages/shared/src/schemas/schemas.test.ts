import { describe, expect, it } from 'vitest';
import { createRequestSchema, loginSchema, registerSchema } from './index';

describe('loginSchema', () => {
  it('accepts a valid credential pair', () => {
    const parsed = loginSchema.parse({ email: 'buyer@demo.com', password: 'password123' });
    expect(parsed.email).toBe('buyer@demo.com');
  });

  it('rejects a malformed email', () => {
    expect(loginSchema.safeParse({ email: 'not-an-email', password: 'password123' }).success).toBe(false);
  });

  it('enforces the minimum password length', () => {
    expect(loginSchema.safeParse({ email: 'buyer@demo.com', password: 'short' }).success).toBe(false);
  });
});

describe('registerSchema', () => {
  const valid = {
    email: 'new@demo.com',
    password: 'password123',
    firstName: 'Ada',
    lastName: 'Lovelace',
    companyName: 'Analytical Engines',
    companySlug: 'analytical-engines',
  };

  it('accepts a complete registration', () => {
    expect(registerSchema.parse(valid).companySlug).toBe('analytical-engines');
  });

  it('requires every identifying field', () => {
    for (const field of ['firstName', 'lastName', 'companyName'] as const) {
      const { [field]: _omitted, ...rest } = valid;
      expect(registerSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('restricts the slug to a URL-safe alphabet', () => {
    expect(registerSchema.safeParse({ ...valid, companySlug: 'Has Spaces' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, companySlug: 'UPPER' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, companySlug: 'ok-slug-1' }).success).toBe(true);
  });
});

describe('createRequestSchema', () => {
  const valid = {
    title: 'Bearing assortment',
    description: 'Sealed bearings for the Gurugram plant maintenance team.',
    item: 'Industrial bearing set',
    quantity: 12,
    location: 'Warehouse 4, Gurugram',
    requiredDate: '2026-10-31T00:00:00.000Z',
  };

  it('applies the default priority when omitted', () => {
    expect(createRequestSchema.parse(valid).priority).toBe(1);
  });

  it('rejects a non-positive or fractional quantity', () => {
    expect(createRequestSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, quantity: -5 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false);
  });

  it('constrains priority to the documented 1-5 range', () => {
    expect(createRequestSchema.safeParse({ ...valid, priority: 0 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, priority: 6 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, priority: 5 }).success).toBe(true);
  });

  it('requires an ISO datetime rather than a bare date', () => {
    expect(createRequestSchema.safeParse({ ...valid, requiredDate: '2026-10-31' }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, requiredDate: 'yesterday' }).success).toBe(false);
  });

  it('requires a substantive description', () => {
    expect(createRequestSchema.safeParse({ ...valid, description: 'too short' }).success).toBe(false);
  });

  it('rejects a non-positive estimated budget when supplied', () => {
    expect(createRequestSchema.safeParse({ ...valid, estimatedBudget: 0 }).success).toBe(false);
    expect(createRequestSchema.safeParse({ ...valid, estimatedBudget: 50000 }).success).toBe(true);
  });
});