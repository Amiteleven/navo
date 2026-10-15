import { Quote } from '@prisma/client';

export interface ComparisonData {
  id?: string;
  basePrice: number;
  taxAmount: number;
  freightAmount: number;
  installationAmount: number;
  otherCharges: number;
  totalLandedCost: number;
  deliveryDays?: number;
  paymentTerms?: string;
  warrantyMonths?: number;
  validityDays?: number;
  score?: number;
  rank?: number;
  notes?: string;
}

export function calculateComparison(quote: Quote & { rfq?: { requiredDeliveryDate: Date } }): ComparisonData {
  const basePrice = quote.unitPrice * quote.quantity;
  const taxAmount = quote.taxAmount;
  const freightAmount = quote.freightAmount;
  const installationAmount = quote.installationAmount;
  const otherCharges = quote.otherCharges;
  
  const totalLandedCost = basePrice + taxAmount + freightAmount + installationAmount + otherCharges;
  
  return {
    basePrice,
    taxAmount,
    freightAmount,
    installationAmount,
    otherCharges,
    totalLandedCost,
    deliveryDays: quote.deliveryTimelineDays || undefined,
    paymentTerms: quote.paymentTerms || undefined,
    warrantyMonths: quote.warrantyMonths || undefined,
    validityDays: quote.validityDays || undefined,
  };
}

export function normalizeQuotes(
  quotes: Array<Quote & { comparison?: ComparisonData | null; vendor: { name: string; status: string } }>
): Array<Quote & { comparison: ComparisonData; normalizedScore?: number }> {
  const withComparison = quotes.filter((q) => q.comparison);
  
  if (withComparison.length === 0) {
    return quotes as Array<Quote & { comparison: ComparisonData }>;
  }
  
  // Find min/max for normalization
  const costs = withComparison.map((q) => q.comparison!.totalLandedCost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const costRange = maxCost - minCost || 1;
  
  const deliveryDays = withComparison
    .map((q) => q.comparison!.deliveryDays)
    .filter((d): d is number => d !== undefined);
  const minDelivery = deliveryDays.length > 0 ? Math.min(...deliveryDays) : 0;
  const maxDelivery = deliveryDays.length > 0 ? Math.max(...deliveryDays) : 1;
  const deliveryRange = maxDelivery - minDelivery || 1;
  
  return quotes.map((quote) => {
    if (!quote.comparison) {
      return quote as Quote & { comparison: ComparisonData };
    }
    
    const comp = quote.comparison;
    
    // Normalize cost (lower is better): 0-100
    const costScore = costRange > 0 
      ? 100 - ((comp.totalLandedCost - minCost) / costRange) * 100 
      : 100;
    
    // Normalize delivery (lower is better): 0-100
    const deliveryScore = comp.deliveryDays && deliveryRange > 0
      ? 100 - ((comp.deliveryDays - minDelivery) / deliveryRange) * 100
      : comp.deliveryDays ? 50 : 0;
    
    // Warranty score (higher is better): 0-100
    const warrantyScore = comp.warrantyMonths ? Math.min(100, (comp.warrantyMonths / 36) * 100) : 0;
    
    // Combined normalized score (weighted)
    const normalizedScore = 
      costScore * 0.4 + 
      deliveryScore * 0.2 + 
      warrantyScore * 0.1 + 
      50 * 0.3; // Base score for other factors
    
    return {
      ...quote,
      comparison: comp,
      normalizedScore: Math.round(normalizedScore * 100) / 100,
    };
  });
}