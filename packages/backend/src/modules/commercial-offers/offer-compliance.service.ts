import { Prisma } from '@prisma/client';
import { OfferComplianceStatus, OfferType } from '@prisma/client';
import { ValidationError } from '../../utils/errors';
import { toDecimal } from '../../utils/money';

/**
 * Evaluates whether a commercial submission satisfies the mandatory
 * requirements of the underlying procurement request.
 *
 * Only deterministic rules are enforced here. AI may *assist* by flagging
 * concerns, but it never overrides a deterministic rule — compliance is
 * computed from stored values only.
 */

export interface ComplianceContext {
  requestId: string;
  quantity: number;
  unit?: string | null;
  requiredDate?: Date | null;
  category?: string | null;
  specifications?: string | null;
  location?: string | null;
}

interface ComplianceResult {
  status: OfferComplianceStatus;
  details: {
    compliant: boolean;
    checks: Array<{
      field: string;
      passed: boolean;
      message: string;
      severity: 'REQUIRED' | 'RECOMMENDED';
    }>;
    missingFields: string[];
    issues: string[];
  };
}

/**
 * Evaluate a submission against the requirement's mandatory fields.
 *
 * The evaluation is deterministic and based solely on stored data.
 * No AI inference or external data is used for the mandatory checks.
 */
export function evaluateCompliance(
  submission: {
    offerType: OfferType;
    currency: string;
    subTotal: Prisma.Decimal | number;
    taxAmount?: Prisma.Decimal | number | null;
    totalAmount: Prisma.Decimal | number;
    discountAmount?: Prisma.Decimal | number | null;
    discountPercentage?: number | null;
    unitPrice?: Prisma.Decimal | number | null;
    quantity?: number | null;
    deliveryDate?: Date | null;
    paymentTerms?: string | null;
    offerValidityDays?: number | null;
    offerValidityDate?: Date | null;
    contractDuration?: string | null;
    staffingAssumptions?: string | null;
    numberOfLicenses?: number | null;
    billingFrequency?: string | null;
    subscriptionTerm?: string | null;
    commercialConditions?: string | null;
    scope?: string | null;
    exclusions?: string | null;
  },
  context: ComplianceContext
): ComplianceResult {
  const checks: ComplianceResult['details']['checks'] = [];
  const missingFields: string[] = [];
  const issues: string[] = [];

  // --- Core monetary validation ---
  const subTotal = toDecimal(submission.subTotal, 'subTotal');
  const totalAmount = toDecimal(submission.totalAmount, 'totalAmount');
  const taxAmount = submission.taxAmount ? toDecimal(submission.taxAmount, 'taxAmount') : null;

  // Amounts must not be negative
  if (subTotal.isNegative()) {
    checks.push({
      field: 'subTotal',
      passed: false,
      message: 'Subtotal cannot be negative',
      severity: 'REQUIRED',
    });
    issues.push('Subtotal cannot be negative');
  } else {
    checks.push({
      field: 'subTotal',
      passed: true,
      message: 'Subtotal is valid',
      severity: 'REQUIRED',
    });
  }

  if (totalAmount.isNegative()) {
    checks.push({
      field: 'totalAmount',
      passed: false,
      message: 'Total amount cannot be negative',
      severity: 'REQUIRED',
    });
    issues.push('Total amount cannot be negative');
  } else {
    checks.push({
      field: 'totalAmount',
      passed: true,
      message: 'Total amount is valid',
      severity: 'REQUIRED',
    });
  }

  if (taxAmount && taxAmount.isNegative()) {
    checks.push({
      field: 'taxAmount',
      passed: false,
      message: 'Tax amount cannot be negative',
      severity: 'REQUIRED',
    });
    issues.push('Tax amount cannot be negative');
  }

  // Tax-inclusive validation: total should be >= subtotal
  if (subTotal.gte(0) && totalAmount.lt(subTotal)) {
    checks.push({
      field: 'totalAmount',
      passed: false,
      message: 'Total amount must be greater than or equal to subtotal',
      severity: 'REQUIRED',
    });
    issues.push('Total amount must be >= subtotal');
  }

  // --- Quantity validation ---
  if (submission.quantity !== null && submission.quantity !== undefined) {
    if (submission.quantity <= 0) {
      checks.push({
        field: 'quantity',
        passed: false,
        message: 'Quantity must be greater than zero',
        severity: 'REQUIRED',
      });
      issues.push('Quantity must be greater than zero');
    } else {
      checks.push({
        field: 'quantity',
        passed: true,
        message: 'Quantity is valid',
        severity: 'REQUIRED',
      });
    }
  } else {
    missingFields.push('quantity');
  }

  // --- Unit price validation ---
  if (submission.unitPrice !== null && submission.unitPrice !== undefined) {
    const unitPrice = toDecimal(submission.unitPrice, 'unitPrice');
    if (unitPrice.isNegative()) {
      checks.push({
        field: 'unitPrice',
        passed: false,
        message: 'Unit price cannot be negative',
        severity: 'REQUIRED',
      });
      issues.push('Unit price cannot be negative');
    } else {
      checks.push({
        field: 'unitPrice',
        passed: true,
        message: 'Unit price is valid',
        severity: 'REQUIRED',
      });
    }
  }

  // --- Currency validation ---
  const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'CNY', 'SGD'];
  if (!SUPPORTED_CURRENCIES.includes(submission.currency)) {
    checks.push({
      field: 'currency',
      passed: false,
      message: `Unsupported currency: ${submission.currency}`,
      severity: 'REQUIRED',
    });
    issues.push(`Unsupported currency: ${submission.currency}`);
  } else {
    checks.push({
      field: 'currency',
      passed: true,
      message: `Currency ${submission.currency} is supported`,
      severity: 'REQUIRED',
    });
  }

  // --- Offer type-specific checks ---
  if (submission.offerType === OfferType.PRODUCT) {
    if (submission.unitPrice === null || submission.unitPrice === undefined) {
      checks.push({
        field: 'unitPrice',
        passed: false,
        message: 'Unit price is required for product offers',
        severity: 'REQUIRED',
      });
      missingFields.push('unitPrice');
    }
    if (submission.quantity === null || submission.quantity === undefined) {
      checks.push({
        field: 'quantity',
        passed: false,
        message: 'Quantity is required for product offers',
        severity: 'REQUIRED',
      });
      missingFields.push('quantity');
    }
  }

  if (submission.offerType === OfferType.SERVICE) {
    if (!submission.contractDuration) {
      checks.push({
        field: 'contractDuration',
        passed: false,
        message: 'Contract duration is required for service offers',
        severity: 'REQUIRED',
      });
      missingFields.push('contractDuration');
    }
    if (!submission.paymentTerms) {
      checks.push({
        field: 'paymentTerms',
        passed: false,
        message: 'Payment terms are strongly recommended for service offers',
        severity: 'RECOMMENDED',
      });
    }
  }

  if (submission.offerType === OfferType.SOFTWARE_SUBSCRIPTION) {
    if (submission.numberOfLicenses !== null && submission.numberOfLicenses !== undefined) {
      if (submission.numberOfLicenses <= 0) {
        checks.push({
          field: 'numberOfLicenses',
          passed: false,
          message: 'Number of licenses must be greater than zero',
          severity: 'REQUIRED',
        });
        issues.push('Number of licenses must be greater than zero');
      }
    } else {
      checks.push({
        field: 'numberOfLicenses',
        passed: false,
        message: 'Number of licenses is required for SaaS offers',
        severity: 'REQUIRED',
      });
      missingFields.push('numberOfLicenses');
    }
    if (!submission.billingFrequency) {
      checks.push({
        field: 'billingFrequency',
        passed: false,
        message: 'Billing frequency is required for SaaS offers',
        severity: 'REQUIRED',
      });
      missingFields.push('billingFrequency');
    }
    if (!submission.subscriptionTerm) {
      checks.push({
        field: 'subscriptionTerm',
        passed: false,
        message: 'Subscription term is required for SaaS offers',
        severity: 'REQUIRED',
      });
      missingFields.push('subscriptionTerm');
    }
  }

  // --- Delivery / validity date checks ---
  if (submission.deliveryDate) {
    const deliveryDate = new Date(submission.deliveryDate);
    if (context.requiredDate && deliveryDate > context.requiredDate) {
      checks.push({
        field: 'deliveryDate',
        passed: false,
        message: 'Delivery date exceeds the required delivery date',
        severity: 'REQUIRED',
      });
      issues.push('Delivery date exceeds required date');
    } else {
      checks.push({
        field: 'deliveryDate',
        passed: true,
        message: 'Delivery date is within requirement',
        severity: 'REQUIRED',
      });
    }
  } else {
    missingFields.push('deliveryDate');
  }

  if (submission.offerValidityDays !== null && submission.offerValidityDays !== undefined) {
    if (submission.offerValidityDays <= 0) {
      checks.push({
        field: 'offerValidityDays',
        passed: false,
        message: 'Offer validity days must be positive',
        severity: 'REQUIRED',
      });
      issues.push('Offer validity must be positive');
    }
  }

  // --- Required commercial terms ---
  if (!submission.paymentTerms) {
    checks.push({
      field: 'paymentTerms',
      passed: false,
      message: 'Payment terms are required',
      severity: 'REQUIRED',
    });
    missingFields.push('paymentTerms');
  } else {
    checks.push({
      field: 'paymentTerms',
      passed: true,
      message: 'Payment terms provided',
      severity: 'REQUIRED',
    });
  }

  if (!submission.scope) {
    checks.push({
      field: 'scope',
      passed: false,
      message: 'Scope description is required',
      severity: 'RECOMMENDED',
    });
  }

  // --- Determine overall compliance status ---
  const requiredFailed = checks.some((c) => !c.passed && c.severity === 'REQUIRED');
  const allPassed = checks.every((c) => c.passed);

  let status: OfferComplianceStatus;
  if (allPassed) {
    status = OfferComplianceStatus.COMPLIANT;
  } else if (requiredFailed) {
    status = OfferComplianceStatus.NON_COMPLIANT;
  } else {
    status = OfferComplianceStatus.PARTIALLY_COMPLIANT;
  }

  return {
    status,
    details: {
      compliant: requiredFailed ? false : allPassed || missingFields.length > 0,
      checks,
      missingFields,
      issues,
    },
  };
}

/**
 * Validate that the submission's quantity matches the requirement's quantity.
 * Used as an additional compliance check.
 */
export function validateQuantityMatch(
  submissionQuantity: number,
  requirementQuantity: number,
  tolerance: number = 0
): boolean {
  return Math.abs(submissionQuantity - requirementQuantity) <= tolerance;
}

/**
 * Validate that the delivery date is achievable based on the requirement.
 */
export function validateDeliveryDate(
  deliveryDate: Date,
  requiredDate?: Date | null
): { valid: boolean; message: string } {
  if (requiredDate && deliveryDate > requiredDate) {
    return {
      valid: false,
      message: `Delivery date ${deliveryDate.toISOString()} exceeds required date ${requiredDate.toISOString()}`,
    };
  }
  return { valid: true, message: 'Delivery date is acceptable' };
}
