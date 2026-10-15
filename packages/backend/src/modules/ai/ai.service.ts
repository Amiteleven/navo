import OpenAI from 'openai';
import { config } from '../../config';

const openai = new OpenAI({
  apiKey: config.openai.apiKey,
});

export interface ExtractedRequirement {
  category?: string;
  item?: string;
  quantity?: number;
  unit?: string;
  location?: string;
  requiredDate?: string;
  specifications?: string;
  budget?: number;
  missingFields: string[];
  confidence: number;
}

const EXTRACTION_PROMPT = `You are NAVO, an autonomous procurement agent. Extract structured procurement information from the user's natural language request.

Return a JSON object with these fields:
- category: The procurement category (e.g., "IT Hardware", "Office Supplies", "Professional Services", "Software", "Facilities", "Marketing", "Travel")
- item: The specific item or service needed
- quantity: Number (if mentioned)
- unit: Unit of measure (e.g., "units", "licenses", "hours", "months")
- location: Delivery/service location
- requiredDate: Date in ISO format (YYYY-MM-DD) if mentioned
- specifications: Technical/functional specifications mentioned
- budget: Estimated budget if mentioned
- missingFields: Array of field names that are missing but would be helpful
- confidence: Your confidence score 0-1

Only include fields that are clearly mentioned or can be reasonably inferred. Be conservative with confidence.

Examples:

Input: "We need 50 laptops for our Bangalore office by 15 November."
Output:
{
  "category": "IT Hardware",
  "item": "Laptop",
  "quantity": 50,
  "unit": "units",
  "location": "Bangalore",
  "requiredDate": "2024-11-15",
  "specifications": null,
  "budget": null,
  "missingFields": ["specifications", "budget"],
  "confidence": 0.9
}

Input: "Looking for a marketing agency for our Q1 campaign, budget around $50k"
Output:
{
  "category": "Marketing",
  "item": "Marketing Agency Services",
  "quantity": 1,
  "unit": "engagement",
  "location": null,
  "requiredDate": null,
  "specifications": "Q1 campaign",
  "budget": 50000,
  "missingFields": ["location", "requiredDate", "detailed specifications"],
  "confidence": 0.8
}`;

export async function extractRequirements(naturalLanguage: string): Promise<ExtractedRequirement> {
  if (!config.openai.apiKey) {
    // Fallback for development without OpenAI key
    return fallbackExtraction(naturalLanguage);
  }
  
  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: naturalLanguage },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    
    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error('No response from AI');
    }
    
    const parsed = JSON.parse(content);
    
    // Validate and normalize
    return {
      category: parsed.category || undefined,
      item: parsed.item || undefined,
      quantity: parsed.quantity ? Number(parsed.quantity) : undefined,
      unit: parsed.unit || undefined,
      location: parsed.location || undefined,
      requiredDate: parsed.requiredDate || undefined,
      specifications: parsed.specifications || undefined,
      budget: parsed.budget ? Number(parsed.budget) : undefined,
      missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch (error) {
    console.error('AI extraction failed:', error);
    return fallbackExtraction(naturalLanguage);
  }
}

function fallbackExtraction(text: string): ExtractedRequirement {
  const lower = text.toLowerCase();
  
  // Simple keyword-based extraction for development
  const result: ExtractedRequirement = {
    missingFields: [],
    confidence: 0.3,
  };
  
  // Category detection
  if (lower.includes('laptop') || lower.includes('computer') || lower.includes('hardware')) {
    result.category = 'IT Hardware';
  } else if (lower.includes('software') || lower.includes('license') || lower.includes('saas')) {
    result.category = 'Software';
  } else if (lower.includes('office') || lower.includes('stationery') || lower.includes('supplies')) {
    result.category = 'Office Supplies';
  } else if (lower.includes('service') || lower.includes('consulting') || lower.includes('agency')) {
    result.category = 'Professional Services';
  }
  
  // Quantity extraction
  const qtyMatch = text.match(/(\d+)\s*(laptops?|computers?|units?|licenses?|items?)/i);
  if (qtyMatch) {
    result.quantity = parseInt(qtyMatch[1], 10);
    result.unit = 'units';
  }
  
  // Item extraction
  if (lower.includes('laptop')) result.item = 'Laptop';
  else if (lower.includes('software')) result.item = 'Software License';
  else if (lower.includes('marketing')) result.item = 'Marketing Services';
  
  // Location extraction
  const locations = ['bangalore', 'mumbai', 'delhi', 'hyderabad', 'chennai', 'pune', 'kolkata'];
  for (const loc of locations) {
    if (lower.includes(loc)) {
      result.location = loc.charAt(0).toUpperCase() + loc.slice(1);
      break;
    }
  }
  
  // Date extraction (simple)
  const dateMatch = text.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i);
  if (dateMatch) {
    result.requiredDate = dateMatch[0];
  }
  
  // Budget extraction
  const budgetMatch = text.match(/\$?(\d+(?:,\d{3})*(?:\.\d+)?)\s*[kmb]?/i);
  if (budgetMatch && (lower.includes('budget') || lower.includes('cost') || lower.includes('price'))) {
    result.budget = parseFloat(budgetMatch[1].replace(/,/g, ''));
  }
  
  // Determine missing fields
  const required = ['category', 'item', 'quantity', 'location', 'requiredDate', 'specifications', 'budget'];
  for (const field of required) {
    if (!result[field as keyof ExtractedRequirement]) {
      result.missingFields.push(field);
    }
  }
  
  return result;
}

interface QuoteForRecommendation {
  id: string;
  vendor: { name: string; status: string };
  totalLandedCost: number;
  deliveryDays: number;
  warrantyMonths: number;
  paymentTerms: string;
}

export async function generateRecommendation(
  quotes: QuoteForRecommendation[],
  request: { item: string; quantity: number; location: string; requiredDate: Date }
): Promise<{
  recommendedQuoteId: string;
  reasoning: string;
  factors: Record<string, unknown>;
  scores: Record<string, number>;
}> {
  if (!config.openai.apiKey || quotes.length === 0) {
    return fallbackRecommendation(quotes);
  }
  
  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are NAVO's recommendation engine. Analyze vendor quotations and provide a recommendation.
          
Consider these factors (weight in parentheses):
- Commercial value / total landed cost (30%)
- Delivery timeline vs required date (20%)
- Specifications compliance (15%)
- Vendor approval status & historical performance (15%)
- Payment terms (10%)
- Warranty (5%)
- Risk factors (5%)

Return JSON with:
- recommendedQuoteId: The vendor quote ID you recommend
- reasoning: Clear business explanation
- factors: Key factors considered
- scores: Individual factor scores 0-100`,
        },
        {
          role: 'user',
          content: JSON.stringify({ quotes, request }, null, 2),
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('No response');
    
    return JSON.parse(content);
  } catch (error) {
    console.error('AI recommendation failed:', error);
    return fallbackRecommendation(quotes);
  }
}

function fallbackRecommendation(quotes: QuoteForRecommendation[]) {
  if (quotes.length === 0) {
    return {
      recommendedQuoteId: '',
      reasoning: 'No quotes available for comparison',
      factors: {} as Record<string, unknown>,
      scores: {} as Record<string, number>,
    };
  }
  
  // Simple fallback: lowest total landed cost
  const sorted = [...quotes].sort((a, b) => a.totalLandedCost - b.totalLandedCost);
  const best = sorted[0];
  
  return {
    recommendedQuoteId: best.id,
    reasoning: `Recommended based on lowest total landed cost of ${best.totalLandedCost.toLocaleString()}.`,
    factors: { primary: 'cost' } as Record<string, unknown>,
    scores: { commercial: 80, delivery: 70, specifications: 70, vendor: 70, payment: 70, warranty: 70, risk: 70 } as Record<string, number>,
  };
}

export interface QuoteAnalysisInput {
  quote: {
    id: string;
    vendor: { name: string; status: string; verificationStatus?: string };
    unitPrice: number;
    quantity: number;
    taxRate: number;
    taxAmount: number;
    freightAmount: number;
    installationAmount: number;
    warrantyMonths?: number;
    deliveryTimelineDays?: number;
    paymentTerms?: string;
    validityDays?: number;
    otherCharges: number;
    otherChargesDetails?: string;
    specifications?: string;
  };
  request: {
    item: string;
    quantity: number;
    location: string;
    requiredDate: Date;
    specifications?: string;
    estimatedBudget?: number;
  };
  historicalQuotes?: Array<{
    vendor: string;
    unitPrice: number;
    quantity: number;
    totalLandedCost: number;
    date: Date;
    specifications?: string;
  }>;
  benchmarkData?: {
    minPrice: number;
    avgPrice: number;
    maxPrice: number;
    sampleSize: number;
    dataSource: string;
    periodStart: Date;
    periodEnd: Date;
  };
}

export interface QuoteAnalysisResult {
  commercialSummary: string;
  priceBenchmark: {
    currentQuote: number;
    minPrice?: number;
    avgPrice?: number;
    maxPrice?: number;
    historicalComparison?: string;
    dataSource?: string;
    sampleSize?: number;
    confidence: number;
  };
  differences: Array<{
    field: string;
    current: string | number;
    comparison: string | number;
    difference: string | number;
    impact: 'high' | 'medium' | 'low';
  }>;
  tradeoffs: Array<{
    supplier: string;
    pros: string[];
    cons: string[];
  }>;
  negotiationStrategy?: {
    targetPrice: number;
    approach: string;
    keyPoints: string[];
    draftMessage: string;
    tradeoffs: string[];
  };
  savingsEstimation?: {
    potentialSavings: number;
    savingsPercentage: number;
    baseline: number;
    baselineSource: string;
    confidence: number;
  };
  missingInfo: string[];
  warnings: string[];
}

export async function analyzeQuote(
  input: QuoteAnalysisInput
): Promise<QuoteAnalysisResult> {
  if (!config.openai.apiKey) {
    return fallbackQuoteAnalysis(input);
  }

  const basePrice = input.quote.unitPrice * input.quote.quantity;
  const totalLandedCost = basePrice + input.quote.taxAmount + input.quote.freightAmount + input.quote.installationAmount + input.quote.otherCharges;

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are NAVO's AI Commercial Intelligence engine. Analyze vendor quotations and provide structured commercial analysis.

CRITICAL RULES:
1. Use ONLY the data provided. Do not invent prices, benchmarks, or historical data.
2. If historical data is insufficient, explicitly state "Insufficient historical data".
3. All calculations must be deterministic and verifiable.
4. Distinguish between buyer's own history, NAVO network data, and external sources.
5. Never present estimates as guaranteed market prices.
6. Base savings calculations on actual comparable transactions only.

Return JSON with these exact fields:
{
  "commercialSummary": "Plain language summary of the quote's commercial terms",
  "priceBenchmark": {
    "currentQuote": number,
    "minPrice": number|null,
    "avgPrice": number|null,
    "maxPrice": number|null,
    "historicalComparison": "string or null",
    "dataSource": "string or null",
    "sampleSize": number|null,
    "confidence": number
  },
  "differences": [
    {"field": "string", "current": "string|number", "comparison": "string|number", "difference": "string|number", "impact": "high|medium|low"}
  ],
  "tradeoffs": [
    {"supplier": "string", "pros": ["string"], "cons": ["string"]}
  ],
  "negotiationStrategy": {
    "targetPrice": number,
    "approach": "string",
    "keyPoints": ["string"],
    "draftMessage": "string",
    "tradeoffs": ["string"]
  },
  "savingsEstimation": {
    "potentialSavings": number,
    "savingsPercentage": number,
    "baseline": number,
    "baselineSource": "string",
    "confidence": number
  },
  "missingInfo": ["string"],
  "warnings": ["string"]
}`,
        },
        {
          role: 'user',
          content: JSON.stringify(input, null, 2),
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('No response from AI');

    const parsed = JSON.parse(content);
    
    // Validate and ensure required fields
    return {
      commercialSummary: parsed.commercialSummary || '',
      priceBenchmark: parsed.priceBenchmark || { currentQuote: totalLandedCost, confidence: 0 },
      differences: parsed.differences || [],
      tradeoffs: parsed.tradeoffs || [],
      negotiationStrategy: parsed.negotiationStrategy || undefined,
      savingsEstimation: parsed.savingsEstimation || undefined,
      missingInfo: parsed.missingInfo || [],
      warnings: parsed.warnings || [],
    };
  } catch (error) {
    console.error('AI quote analysis failed:', error);
    return fallbackQuoteAnalysis(input);
  }
}

function fallbackQuoteAnalysis(input: QuoteAnalysisInput): QuoteAnalysisResult {
  const basePrice = input.quote.unitPrice * input.quote.quantity;
  const totalLandedCost = basePrice + input.quote.taxAmount + input.quote.freightAmount + input.quote.installationAmount + input.quote.otherCharges;

  const missingInfo: string[] = [];
  const warnings: string[] = [];

  if (!input.quote.warrantyMonths) missingInfo.push('Warranty period');
  if (!input.quote.paymentTerms) missingInfo.push('Payment terms');
  if (!input.quote.validityDays) missingInfo.push('Quote validity');
  if (!input.quote.specifications) missingInfo.push('Detailed specifications');

  let historicalComparison: string | undefined;
  let dataSource: string | undefined;
  let sampleSize: number | undefined;
  let minPrice: number | undefined;
  let avgPrice: number | undefined;
  let maxPrice: number | undefined;
  let benchmarkConfidence = 0;

  if (input.historicalQuotes && input.historicalQuotes.length >= 3) {
    const prices = input.historicalQuotes.map(q => q.unitPrice);
    minPrice = Math.min(...prices);
    avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    maxPrice = Math.max(...prices);
    sampleSize = input.historicalQuotes.length;
    dataSource = 'Buyer transaction history';
    benchmarkConfidence = Math.min(0.8, 0.3 + (sampleSize * 0.1));
    
    const pctDiff = ((input.quote.unitPrice - avgPrice) / avgPrice) * 100;
    historicalComparison = pctDiff > 5 
      ? `Current quote is ${pctDiff.toFixed(1)}% above historical average`
      : pctDiff < -5
        ? `Current quote is ${Math.abs(pctDiff).toFixed(1)}% below historical average`
        : `Current quote is within ${Math.abs(pctDiff).toFixed(1)}% of historical average`;
  } else if (input.benchmarkData && input.benchmarkData.sampleSize >= 5) {
    minPrice = input.benchmarkData.minPrice;
    avgPrice = input.benchmarkData.avgPrice;
    maxPrice = input.benchmarkData.maxPrice;
    sampleSize = input.benchmarkData.sampleSize;
    dataSource = input.benchmarkData.dataSource;
    benchmarkConfidence = Math.min(0.7, 0.2 + (sampleSize * 0.05));

    const pctDiff = ((input.quote.unitPrice - avgPrice) / avgPrice) * 100;
    historicalComparison = pctDiff > 5
      ? `Current quote is ${pctDiff.toFixed(1)}% above ${dataSource} average`
      : pctDiff < -5
        ? `Current quote is ${Math.abs(pctDiff).toFixed(1)}% below ${dataSource} average`
        : `Current quote is within ${Math.abs(pctDiff).toFixed(1)}% of ${dataSource} average`;
  } else {
    warnings.push('Insufficient historical data for reliable benchmarking');
    benchmarkConfidence = 0.1;
  }

  const differences: QuoteAnalysisResult['differences'] = [];
  
  if (input.request.estimatedBudget) {
    const budgetDiff = totalLandedCost - input.request.estimatedBudget;
    differences.push({
      field: 'Budget vs Quote',
      current: totalLandedCost,
      comparison: input.request.estimatedBudget,
      difference: budgetDiff,
      impact: Math.abs(budgetDiff) > input.request.estimatedBudget * 0.1 ? 'high' : 'medium',
    });
  }

  if (input.quote.deliveryTimelineDays && input.request.requiredDate) {
    const requiredDays = Math.ceil((new Date(input.request.requiredDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const deliveryDiff = input.quote.deliveryTimelineDays - requiredDays;
    differences.push({
      field: 'Delivery timeline',
      current: `${input.quote.deliveryTimelineDays} days`,
      comparison: `${requiredDays} days required`,
      difference: deliveryDiff > 0 ? `${deliveryDiff} days late` : `${Math.abs(deliveryDiff)} days early`,
      impact: deliveryDiff > 0 ? 'high' : 'low',
    });
  }

  const tradeoffs = [
    {
      supplier: input.quote.vendor.name,
      pros: [
        input.quote.warrantyMonths ? `${input.quote.warrantyMonths}-month warranty` : 'N/A',
        input.quote.freightAmount === 0 ? 'Free delivery' : `₹${input.quote.freightAmount} delivery`,
        input.quote.paymentTerms || 'Standard terms',
      ].filter(Boolean),
      cons: [
        input.quote.unitPrice > (avgPrice || totalLandedCost) ? 'Above average price' : 'Competitive price',
        input.quote.deliveryTimelineDays && input.quote.deliveryTimelineDays > 30 ? 'Long delivery time' : 'Reasonable delivery',
      ].filter(Boolean),
    },
  ];

  let potentialSavings = 0;
  let savingsPercentage = 0;
  let baseline = totalLandedCost;
  let baselineSource = 'Current quote';
  let savingsConfidence = 0.3;

  if (input.historicalQuotes && input.historicalQuotes.length >= 2) {
    const historicalAvg = input.historicalQuotes.reduce((sum, q) => sum + (q.unitPrice * q.quantity), 0) / input.historicalQuotes.length;
    if (totalLandedCost > historicalAvg * 1.05) {
      potentialSavings = totalLandedCost - historicalAvg;
      savingsPercentage = (potentialSavings / totalLandedCost) * 100;
      baseline = historicalAvg;
      baselineSource = 'Historical average';
      savingsConfidence = 0.6;
    }
  }

  return {
    commercialSummary: `Quote from ${input.quote.vendor.name} for ${input.quote.quantity} ${input.request.item} at ₹${input.quote.unitPrice.toLocaleString()}/unit. Total landed cost: ₹${totalLandedCost.toLocaleString()} (base: ₹${basePrice.toLocaleString()}, tax: ₹${input.quote.taxAmount.toLocaleString()}, freight: ₹${input.quote.freightAmount.toLocaleString()}, installation: ₹${input.quote.installationAmount.toLocaleString()}, other: ₹${input.quote.otherCharges.toLocaleString()}). Delivery: ${input.quote.deliveryTimelineDays || 'Not specified'} days. Warranty: ${input.quote.warrantyMonths || 'Not specified'} months. Payment: ${input.quote.paymentTerms || 'Not specified'}. Valid for ${input.quote.validityDays || 'Not specified'} days.`,
    priceBenchmark: {
      currentQuote: totalLandedCost,
      minPrice,
      avgPrice,
      maxPrice,
      historicalComparison,
      dataSource,
      sampleSize,
      confidence: benchmarkConfidence,
    },
    differences,
    tradeoffs,
    negotiationStrategy: savingsPercentage > 0 ? {
      targetPrice: Math.round(baseline),
      approach: 'Request price alignment with historical purchasing data',
      keyPoints: [
        `Historical average: ₹${Math.round(baseline).toLocaleString()}`,
        `Current quote: ₹${totalLandedCost.toLocaleString()}`,
        `Potential savings: ₹${Math.round(potentialSavings).toLocaleString()} (${savingsPercentage.toFixed(1)}%)`,
      ],
      draftMessage: `Thank you for your quotation. Based on our historical purchasing data for similar ${input.request.item} orders, the average unit price has been approximately ₹${Math.round(baseline / input.quote.quantity).toLocaleString()}. Your current quote of ₹${input.quote.unitPrice.toLocaleString()}/unit is ${savingsPercentage.toFixed(1)}% above this benchmark. Could we explore pricing closer to the historical range? We value this partnership and are open to discussing volume commitments or adjusted delivery terms to reach a mutually beneficial agreement.`,
      tradeoffs: ['Extended delivery timeline', 'Reduced warranty', 'Advance payment'],
    } : undefined,
    savingsEstimation: potentialSavings > 0 ? {
      potentialSavings,
      savingsPercentage,
      baseline,
      baselineSource,
      confidence: savingsConfidence,
    } : undefined,
    missingInfo,
    warnings,
  };
}

export async function generateNegotiationMessage(
  context: {
    currentOffer: {
      unitPrice: number;
      quantity: number;
      totalLandedCost: number;
      deliveryDays: number;
      paymentTerms: string;
      warrantyMonths?: number;
    };
    targetPrice?: number;
    targetDeliveryDays?: number;
    buyerNotes?: string;
    negotiationHistory: Array<{
      from: 'buyer' | 'seller';
      message: string;
      timestamp: Date;
    }>;
    vendorName: string;
  }
): Promise<{
  approach: string;
  draftMessage: string;
  keyPoints: string[];
  tradeoffs: string[];
}> {
  if (!config.openai.apiKey) {
    return fallbackNegotiationMessage(context);
  }

  try {
    const completion = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are NAVO's Negotiation Assistant. Draft professional, evidence-based negotiation messages for procurement buyers.

RULES:
1. Never commit the buyer to a purchase. The message must be a proposal/request, not acceptance.
2. Base arguments on provided data (historical prices, specifications, delivery requirements).
3. Suggest trade-offs that protect buyer interests.
3. Keep tone professional and collaborative.
4. Return JSON only.`,
        },
        {
          role: 'user',
          content: JSON.stringify(context, null, 2),
        },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('No response');

    return JSON.parse(content);
  } catch (error) {
    console.error('AI negotiation message generation failed:', error);
    return fallbackNegotiationMessage(context);
  }
}

function fallbackNegotiationMessage(context: Parameters<typeof generateNegotiationMessage>[0]) {
  const { currentOffer, targetPrice, targetDeliveryDays, buyerNotes } = context;
  
  const keyPoints = [
    `Current offer: ₹${currentOffer.totalLandedCost.toLocaleString()} total landed cost`,
    `Unit price: ₹${currentOffer.unitPrice.toLocaleString()}`,
    `Delivery: ${currentOffer.deliveryDays} days`,
    `Payment: ${currentOffer.paymentTerms}`,
  ];

  if (targetPrice) {
    keyPoints.push(`Target price: ₹${targetPrice.toLocaleString()} (${(((currentOffer.totalLandedCost - targetPrice) / currentOffer.totalLandedCost) * 100).toFixed(1)}% reduction)`);
  }

  const tradeoffs = [
    'Extended delivery timeline (add 7-14 days)',
    'Reduced warranty period (if currently > 12 months)',
    'Advance payment (30-50%) for price reduction',
    'Volume commitment for future orders',
  ];

  const draftMessage = `Dear ${context.vendorName},

Thank you for your quotation of ₹${currentOffer.unitPrice.toLocaleString()}/unit (₹${currentOffer.totalLandedCost.toLocaleString()} total). 

${targetPrice ? `Based on our analysis and historical purchasing data, we were targeting a total landed cost of approximately ₹${targetPrice.toLocaleString()}. ` : ''}Could we discuss the following adjustments to reach a mutually agreeable position?

${keyPoints.map(p => `• ${p}`).join('\n')}

We're open to exploring trade-offs such as:
${tradeoffs.map(t => `• ${t}`).join('\n')}

${buyerNotes || ''}

We value this partnership and look forward to your thoughts.

Best regards,
NAVO Procurement`;

  return {
    approach: targetPrice ? 'Price reduction with trade-offs' : 'Explore commercial terms',
    draftMessage,
    keyPoints,
    tradeoffs,
  };
}