import { describe, expect, it } from 'vitest';
import { OfferComplianceStatus, OfferType } from '@prisma/client';
import {
  evaluateCompliance,
  validateQuantityMatch,
  validateDeliveryDate,
} from '../offer-compliance.service';
import { ComplianceContext } from '../offer-compliance.service';

const baseContext: ComplianceContext = {
  requestId: 'req-1',
  quantity: 100,
  unit: 'units',
  requiredDate: new Date('2026-12-31'),
  category: 'IT Services',
  specifications: 'Must be ISO 9001 certified',
  location: 'Bangalore',
};

const baseSubmission = {
  offerType: OfferType.PRODUCT,
  currency: 'INR',
  subTotal: 1000,
  taxAmount: 180,
  totalAmount: 1180,
  discountAmount: 0,
  discountPercentage: 0,
  unitPrice: 10,
  quantity: 100,
  deliveryDate: new Date('2026-12-01'),
  paymentTerms: 'Net 30',
  offerValidityDays: 30,
  offerValidityDate: null,
  contractDuration: null,
  staffingAssumptions: null,
  numberOfLicenses: null,
  billingFrequency: null,
  subscriptionTerm: null,
  commercialConditions: null,
  scope: 'Standard delivery terms',
  exclusions: null,
};

describe('evaluateCompliance', () => {
  it('returns COMPLIANT when all fields are valid', () => {
    const result = evaluateCompliance(baseSubmission, baseContext);
    expect(result.status).toBe(OfferComplianceStatus.COMPLIANT);
    expect(result.details.compliant).toBe(true);
  });

  it('returns NON_COMPLIANT when subtotal is negative', () => {
    const result = evaluateCompliance({ ...baseSubmission, subTotal: -100, totalAmount: -80 }, baseContext);
    expect(result.status).toBe(OfferComplianceStatus.NON_COMPLIANT);
    expect(result.details.issues).toContain('Subtotal cannot be negative');
    expect(result.details.issues).toContain('Total amount cannot be negative');
  });

  it('returns NON_COMPLIANT when totalAmount is less than subtotal', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, subTotal: 1000, totalAmount: 800 },
      baseContext
    );
    expect(result.status).toBe(OfferComplianceStatus.NON_COMPLIANT);
    expect(result.details.issues).toContain('Total amount must be >= subtotal');
  });

  it('returns NON_COMPLIANT when tax amount is negative', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, subTotal: 1000, taxAmount: -50, totalAmount: 950 },
      baseContext
    );
    expect(result.status).toBe(OfferComplianceStatus.NON_COMPLIANT);
    expect(result.details.issues).toContain('Tax amount cannot be negative');
  });

  it('flags PARTIALLY_COMPLIANT when payment terms are missing (recommended only)', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, scope: null },
      baseContext
    );
    expect(result.status).toBe(OfferComplianceStatus.PARTIALLY_COMPLIANT);
  });

  it('flags NON_COMPLIANT when a required field is missing (paymentTerms)', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, paymentTerms: null },
      baseContext
    );
    expect(result.status).toBe(OfferComplianceStatus.NON_COMPLIANT);
    expect(result.details.missingFields).toContain('paymentTerms');
  });

  it('requires quantity for product offers', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, quantity: null },
      baseContext
    );
    expect(result.status).toBe(OfferComplianceStatus.NON_COMPLIANT);
    expect(result.details.missingFields).toContain('quantity');
  });

  it('requires currency to be a valid 3-letter code', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, currency: 'INVALID' },
      baseContext
    );
    expect(result.details.checks).toContainEqual(
      expect.objectContaining({
        field: 'currency',
        passed: false,
        message: 'Unsupported currency: INVALID',
      })
    );
  });

  it('requires unitPrice for product offers', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, unitPrice: null },
      baseContext
    );
    expect(result.details.checks).toContainEqual(
      expect.objectContaining({
        field: 'unitPrice',
        passed: false,
        message: 'Unit price is required for product offers',
      })
    );
  });

  it('requires numberOfLicenses for SaaS offers', () => {
    const result = evaluateCompliance(
      {
        ...baseSubmission,
        offerType: OfferType.SOFTWARE_SUBSCRIPTION,
        numberOfLicenses: null,
        billingFrequency: 'Annual',
        subscriptionTerm: '1 year',
      },
      baseContext
    );
    expect(result.details.missingFields).toContain('numberOfLicenses');
  });

  it('requires billingFrequency for SaaS offers', () => {
    const result = evaluateCompliance(
      {
        ...baseSubmission,
        offerType: OfferType.SOFTWARE_SUBSCRIPTION,
        numberOfLicenses: 100,
        billingFrequency: null,
        subscriptionTerm: '1 year',
      },
      baseContext
    );
    expect(result.details.missingFields).toContain('billingFrequency');
  });

  it('requires subscriptionTerm for SaaS offers', () => {
    const result = evaluateCompliance(
      {
        ...baseSubmission,
        offerType: OfferType.SOFTWARE_SUBSCRIPTION,
        numberOfLicenses: 100,
        billingFrequency: 'Annual',
        subscriptionTerm: null,
      },
      baseContext
    );
    expect(result.details.missingFields).toContain('subscriptionTerm');
  });

  it('requires contractDuration for service offers', () => {
    const result = evaluateCompliance(
      {
        ...baseSubmission,
        offerType: OfferType.SERVICE,
        contractDuration: null,
      },
      baseContext
    );
    expect(result.details.missingFields).toContain('contractDuration');
  });

  it('requires deliveryDate', () => {
    const result = evaluateCompliance(
      { ...baseSubmission, deliveryDate: null },
      baseContext
    );
    expect(result.details.missingFields).toContain('deliveryDate');
  });

  it('flags deliveryDate that exceeds requirement', () => {
    const result = evaluateCompliance(
      {
        ...baseSubmission,
        deliveryDate: new Date('2027-06-01'),
      },
      baseContext
    );
    expect(result.details.issues).toContain('Delivery date exceeds required date');
  });
});

describe('validateQuantityMatch', () => {
  it('returns true when quantities match exactly', () => {
    expect(validateQuantityMatch(100, 100)).toBe(true);
  });

  it('returns true within tolerance', () => {
    expect(validateQuantityMatch(100, 102, 5)).toBe(true);
    expect(validateQuantityMatch(100, 95, 5)).toBe(true);
  });

  it('returns false outside tolerance', () => {
    expect(validateQuantityMatch(100, 110, 5)).toBe(false);
  });
});

describe('validateDeliveryDate', () => {
  it('returns valid when delivery date is before required date', () => {
    const result = validateDeliveryDate(new Date('2026-11-01'), new Date('2026-12-01'));
    expect(result.valid).toBe(true);
  });

  it('returns invalid when delivery date exceeds required date', () => {
    const result = validateDeliveryDate(new Date('2027-01-01'), new Date('2026-12-01'));
    expect(result.valid).toBe(false);
  });

  it('returns valid when no required date is given', () => {
    const result = validateDeliveryDate(new Date('2027-01-01'), null);
    expect(result.valid).toBe(true);
  });
});
