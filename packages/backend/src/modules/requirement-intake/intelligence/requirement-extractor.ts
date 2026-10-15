/**
 * NAVO Requirement Intelligence Engine — Requirement Extractor
 *
 * Extracts structured procurement requirements from natural language.
 * Never invents, assumes, or hallucinates data. Unknown attributes stay null.
 */

import { ExtractedRequirementData, RequirementType } from './types.js';

interface CategoryInference {
  category: string;
  requirementType: RequirementType;
}

const CATEGORY_RULES: Array<{
  regex: RegExp;
  category: string;
  requirementType: RequirementType;
}> = [
  {
    regex: /\b(chairs?|desks?|tables?|workstations?|sofas?|furniture|cubicles?|cabinets?|storage units?|ergonomic)\b/i,
    category: 'Office Furniture',
    requirementType: 'PRODUCT',
  },
  {
    regex: /\b(iphones?|phones?|mobiles?|smartphones?|androids?|ipads?|tablets?)\b/i,
    category: 'Mobile & Telecom',
    requirementType: 'PRODUCT',
  },
  {
    regex: /\b(laptops?|macbooks?|thinkpads?|desktops?|computers?|monitors?|screens?|servers?|cpus?|keyboards?|mice|mouse)\b/i,
    category: 'IT Hardware & Electronics',
    requirementType: 'PRODUCT',
  },
  {
    regex: /\b(box|boxes|packaging|cartons?|corrugated|packaging material|bubble wraps?|pallets?|crates?)\b/i,
    category: 'Packaging Materials',
    requirementType: 'PRODUCT',
  },
  {
    regex: /\b(cybersecurity|security audits?|penetration test(?:ing)?|pen test(?:ing)?|infosec|soc|firewalls?|antivirus|iso 27001|vulnerability)\b/i,
    category: 'Cybersecurity & Infosec',
    requirementType: 'SERVICE',
  },
  {
    regex: /\b(sap|salesforce|erp|crm|oracle|workday|servicenow|consulting|advisory|consultants?)\b/i,
    category: 'Enterprise Consulting & ERP',
    requirementType: 'CONSULTING',
  },
  {
    regex: /\b(transports?|transportation|cabs?|shuttles?|buses?|commutes?|fleets?|employee transports?)\b/i,
    category: 'Employee Transportation',
    requirementType: 'SERVICE',
  },
  {
    regex: /\b(ai development|software development|app development|web development|devops|full stack|engineering agency)\b/i,
    category: 'Software Development & AI',
    requirementType: 'SERVICE',
  },
  {
    regex: /\b(software|saas|license|subscription|cloud hosting|aws|azure|gcp)\b/i,
    category: 'Software & SaaS',
    requirementType: 'SOFTWARE',
  },
  {
    regex: /\b(raw materials?|steel|iron|aluminum|copper|sheet metals?|cements?|polymers?|resins?|plastic granules?|chemicals?)\b/i,
    category: 'Raw Materials & Metals',
    requirementType: 'RAW_MATERIAL',
  },
  {
    regex: /\b(housekeeping|cleaning|janitorial|facility management|pest control|waste management)\b/i,
    category: 'Facility Management & Housekeeping',
    requirementType: 'FACILITY',
  },
  {
    regex: /\b(maintenance|amc|repair|servicing|annual maintenance|hvac|generator)\b/i,
    category: 'Maintenance & Repair',
    requirementType: 'MAINTENANCE',
  },
  {
    regex: /\b(logistics|freight|cargo|shipping|courier|customs clearance|warehousing)\b/i,
    category: 'Logistics & Freight',
    requirementType: 'LOGISTICS',
  },
  {
    regex: /\b(catering|food|meal|pantry|snacks|coffee machine)\b/i,
    category: 'Corporate Catering & Pantry',
    requirementType: 'SERVICE',
  },
  {
    regex: /\b(event|conference|summit|annual day|offsite|exhibition)\b/i,
    category: 'Event Management',
    requirementType: 'SERVICE',
  },
];

export function extractRequirement(text: string): ExtractedRequirementData {
  const result: ExtractedRequirementData = { rawText: text };
  const lower = text.toLowerCase();

  // 1. Category & Requirement Type Inference
  for (const rule of CATEGORY_RULES) {
    if (rule.regex.test(text)) {
      result.category = rule.category;
      result.requirementType = rule.requirementType;
      break;
    }
  }

  if (!result.category) {
    if (/\b(services?|consulting|agency|firm|provider|maintenance|audit|development)\b/i.test(text)) {
      result.requirementType = 'SERVICE';
      result.category = 'Professional Services';
    } else {
      result.requirementType = 'PRODUCT';
      result.category = 'General Supplies';
    }
  }

  // 2. Item Extraction
  // Target phrases like: "50 office chairs", "an iPhone", "cybersecurity services", "packaging supplier in Germany"
  result.item = extractItemPhrase(text);
  result.title = result.item ? capitalizeWords(result.item) : undefined;

  // 3. Quantity & Unit
  const quantityResult = extractQuantityAndUnit(text);
  if (quantityResult) {
    result.quantity = quantityResult.quantity;
    result.unit = quantityResult.unit;
  }

  // 4. Budget & Currency
  const budgetResult = extractBudget(text);
  if (budgetResult) {
    result.estimatedBudget = budgetResult.amount;
    result.currency = budgetResult.currency;
  }

  // 5. Delivery Location
  const location = extractLocation(text);
  if (location) {
    result.deliveryLocation = location;
  }

  // 6. Required Date / Deadline
  const requiredDate = extractRequiredDate(text);
  if (requiredDate) {
    result.requiredDate = requiredDate;
  }

  // 7. Dynamic Specifications / Category Attributes
  const specs: Record<string, any> = {};

  // Warranty
  const warrantyMatch = text.match(/\b(\d+)[- ]?(year|yr|month|mth)s?\s+warranty\b/i);
  if (warrantyMatch) {
    result.warranty = `${warrantyMatch[1]} ${warrantyMatch[2]}s`;
    specs.warranty = result.warranty;
  }

  // Brand / Model
  const brandMatch = extractBrandOrModel(text);
  if (brandMatch) {
    if (brandMatch.brand) result.brandPreference = brandMatch.brand;
    if (brandMatch.model) result.model = brandMatch.model;
  }

  // Software users
  const userCountMatch = text.match(/\b(\d+)\s+(users?|employees?|people|seats?|licenses?)\b/i);
  if (userCountMatch && (result.requirementType === 'SOFTWARE' || /\b(crm|erp|software)\b/i.test(text))) {
    result.users = parseInt(userCountMatch[1], 10);
    specs.users = result.users;
  }

  // Deployment
  if (/\b(cloud|saas|hosted|on-premise|on-prem|hybrid)\b/i.test(text)) {
    const depMatch = text.match(/\b(cloud|saas|hosted|on-premise|on-prem|hybrid)\b/i);
    if (depMatch) {
      result.deployment = depMatch[1].toLowerCase();
      specs.deployment = result.deployment;
    }
  }

  // Service Duration
  const durationMatch = text.match(/\b(monthly|annually|quarterly|annual|project-based|\d+[- ]?months?|\d+[- ]?years?)\b/i);
  if (durationMatch && (result.requirementType === 'SERVICE' || result.requirementType === 'CONSULTING')) {
    result.serviceDuration = durationMatch[1].toLowerCase();
    specs.serviceDuration = result.serviceDuration;
  }

  // Ergonomic / specific materials
  if (/\bergonomic\b/i.test(text)) {
    specs.ergonomic = true;
  }
  if (/\bmesh back\b/i.test(text)) {
    specs.backType = 'mesh';
  }
  if (/\bcustom\b/i.test(text)) {
    specs.custom = true;
  }

  if (Object.keys(specs).length > 0) {
    result.specifications = specs;
  }

  return result;
}

/**
 * Extract item description from the sentence
 */
function extractItemPhrase(text: string): string {
  // Pattern: "I need 50 office chairs for our Mumbai office" -> "office chairs"
  // Pattern: "We need cybersecurity services" -> "cybersecurity services"
  // Pattern: "Find me a packaging supplier in Germany" -> "packaging"
  // Pattern: "I need an iPhone" -> "iPhone"

  const cleanup = (str: string) =>
    str
      .replace(/\b(for our|for the|for|in|by|under|budget|with|within)\b.*$/i, '')
      .replace(/^\s*(a|an|the|some|\d+[\d,]*)\s+/i, '')
      .trim();

  // "Find me a ... supplier/vendor for [ITEM]"
  const findForMatch = text.match(/find\s+(?:me\s+)?(?:a\s+|an\s+)?(?:supplier|vendor|company)\s+for\s+([^,.]+)/i);
  if (findForMatch) {
    return cleanup(findForMatch[1]);
  }

  // "Find me a [ITEM] supplier/vendor in [LOCATION]"
  const supplierMatch = text.match(/find\s+(?:me\s+)?(?:a\s+|an\s+)?([a-z0-9\s-]+?)\s+(?:supplier|vendor|company|agency)\b/i);
  if (supplierMatch) {
    return cleanup(supplierMatch[1]);
  }

  // "I need / We need [QUANTITY] [ITEM]"
  const needMatch = text.match(/(?:i need|we need|i want|we want|i require|we require|need to source|looking for)\s+([^,.]+)/i);
  if (needMatch) {
    return cleanup(needMatch[1]);
  }

  return cleanup(text);
}

/**
 * Extract quantity and unit
 */
function extractQuantityAndUnit(text: string): { quantity: number; unit?: string } | null {
  // e.g. "10,000 custom boxes", "50 chairs", "100 laptops", "1 iPhone", "an iPhone"

  const numMatch = text.match(/\b(\d{1,3}(?:,\d{3})*|\d+)\s*([a-zA-Z]+)?\b/);
  if (numMatch) {
    const rawNum = numMatch[1].replace(/,/g, '');
    const num = parseInt(rawNum, 10);
    const unitWord = numMatch[2] ? numMatch[2].toLowerCase() : undefined;

    // Filter out numbers that represent years, dates, or prices
    if (num >= 1990 && num <= 2050 && /\b(in|by|year)\s+\d{4}\b/i.test(text)) {
      // It's a year
    } else if (/\b(inr|usd|eur|\$|₹|rs|lakh|crore|k)\b/i.test(numMatch[0])) {
      // It's currency
    } else if (num > 0) {
      const unitsMap: Record<string, string> = {
        chairs: 'units',
        chair: 'units',
        laptops: 'units',
        laptop: 'units',
        boxes: 'boxes',
        box: 'boxes',
        phones: 'units',
        phone: 'units',
        licenses: 'licenses',
        license: 'licenses',
        users: 'users',
        seats: 'seats',
        units: 'units',
        pcs: 'pcs',
        pieces: 'pieces',
        kg: 'kg',
        meters: 'meters',
        hours: 'hours',
      };
      return {
        quantity: num,
        unit: (unitWord && unitsMap[unitWord]) || (unitWord && !['in', 'for', 'by', 'under', 'at', 'our'].includes(unitWord) ? unitWord : 'units'),
      };
    }
  }

  // Singular article: "an iPhone", "a laptop"
  if (/\b(an|a)\s+(iphone|laptop|chair|desk|server|macbook|ipad)\b/i.test(text)) {
    return { quantity: 1, unit: 'units' };
  }

  return null;
}

/**
 * Extract budget and currency
 */
function extractBudget(text: string): { amount: number; currency: string } | null {
  const lower = text.toLowerCase();

  // Indian format: "12 lakhs", "1.5 crore", "50k", "50 thousand"
  const lakhMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:lakhs?|lac|lacs?)\b/);
  if (lakhMatch) {
    const amount = parseFloat(lakhMatch[1]) * 100000;
    return { amount, currency: 'INR' };
  }

  const croreMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:crores?|cr)\b/);
  if (croreMatch) {
    const amount = parseFloat(croreMatch[1]) * 10000000;
    return { amount, currency: 'INR' };
  }

  const kMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*k\b/);
  if (kMatch && /\b(budget|under|price|cost|worth)\b/i.test(lower)) {
    const amount = parseFloat(kMatch[1]) * 1000;
    const currency = detectCurrency(text) || 'INR';
    return { amount, currency };
  }

  // Standard format: "$15,000", "€20,000", "₹50,000", "budget 250000 INR"
  const standardMatch = text.match(/(?:(\$|€|£|₹|Rs\.?)\s*(\d{1,3}(?:,\d{3})*|\d+))|(?:\b(?:budget|cost|price|max)\s*(?:is|of|under|:)?\s*(\d{1,3}(?:,\d{3})*|\d+)\s*(inr|usd|eur|gbp)?\b)/i);
  if (standardMatch) {
    const symbol = standardMatch[1];
    const rawAmount = (standardMatch[2] || standardMatch[3])?.replace(/,/g, '');
    const explicitCurr = standardMatch[4]?.toUpperCase();

    if (rawAmount) {
      const amount = parseFloat(rawAmount);
      let currency = 'INR';
      if (symbol === '$' || explicitCurr === 'USD') currency = 'USD';
      else if (symbol === '€' || explicitCurr === 'EUR') currency = 'EUR';
      else if (symbol === '£' || explicitCurr === 'GBP') currency = 'GBP';
      else if (symbol === '₹' || symbol?.toLowerCase().startsWith('rs') || explicitCurr === 'INR') currency = 'INR';
      else currency = detectCurrency(text) || 'INR';

      return { amount, currency };
    }
  }

  return null;
}

function detectCurrency(text: string): string | null {
  if (/\b(usd|\$)\b/i.test(text)) return 'USD';
  if (/\b(eur|€)\b/i.test(text)) return 'EUR';
  if (/\b(gbp|£)\b/i.test(text)) return 'GBP';
  if (/\b(inr|₹|rs|lakh|crore)\b/i.test(text)) return 'INR';
  return null;
}

/**
 * Extract location from text
 */
function extractLocation(text: string): string | null {
  const cities = [
    'Mumbai', 'Bangalore', 'Bengaluru', 'Pune', 'Delhi', 'New Delhi',
    'Hyderabad', 'Chennai', 'Kolkata', 'Gurgaon', 'Gurugram', 'Noida',
    'Ahmedabad', 'Frankfurt', 'Berlin', 'Munich', 'Hamburg', 'London',
    'Singapore', 'Dubai', 'Tokyo', 'Sydney', 'New York', 'San Francisco',
    'Chicago', 'Austin', 'Paris', 'Amsterdam', 'Toronto',
  ];

  const countries = [
    'Germany', 'India', 'United States', 'US', 'USA', 'UK', 'United Kingdom',
    'Singapore', 'UAE', 'Japan', 'Australia', 'Canada', 'France', 'Europe',
  ];

  for (const city of cities) {
    const regex = new RegExp(`\\b${city}\\b`, 'i');
    if (regex.test(text)) return city;
  }

  for (const country of countries) {
    const regex = new RegExp(`\\b${country}\\b`, 'i');
    if (regex.test(text)) return country;
  }

  // Location phrases: "headquarters", "Bangalore office", "our factory"
  const phraseMatch = text.match(/\b(for\s+our\s+([a-zA-Z\s]+?)\s+(?:office|headquarters|factory|site|campus))\b/i);
  if (phraseMatch) {
    return phraseMatch[2].trim();
  }

  return null;
}

/**
 * Extract required by date
 */
function extractRequiredDate(text: string): Date | null {
  const lower = text.toLowerCase();
  const now = new Date();

  // Relative: "end of month"
  if (/\bend of (?:the\s+)?month\b/i.test(lower)) {
    return new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }

  // "in 2 weeks", "within 2 weeks"
  const weeksMatch = lower.match(/\b(?:in|within)\s+(\d+)\s+weeks?\b/i);
  if (weeksMatch) {
    const weeks = parseInt(weeksMatch[1], 10);
    return new Date(now.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
  }

  // "in 30 days", "within 15 days"
  const daysMatch = lower.match(/\b(?:in|within)\s+(\d+)\s+days?\b/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  }

  // Month names: "December", "by December", "in Dec", "15 Dec", "Dec 15"
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const shortMonth = shortMonths[i];
    const regex = new RegExp(`\\b(?:by\\s+|in\\s+)?(?:(\\d{1,2})\\s+)?(?:${month}|${shortMonth})(?:\\s+(\\d{1,2}))?\\b`, 'i');
    const match = lower.match(regex);
    if (match) {
      const day = match[1] || match[2] || '15';
      let year = now.getFullYear();
      if (i < now.getMonth()) {
        year += 1; // Next year if month has already passed
      }
      return new Date(year, i, parseInt(day, 10));
    }
  }

  return null;
}

/**
 * Extract brand or model
 */
function extractBrandOrModel(text: string): { brand?: string; model?: string } | null {
  const brands = ['Apple', 'Dell', 'HP', 'Lenovo', 'Samsung', 'Herman Miller', 'Steelcase', 'Cisco', 'Microsoft'];
  for (const brand of brands) {
    if (new RegExp(`\\b${brand}\\b`, 'i').test(text)) {
      return { brand };
    }
  }

  // Model pattern: "iPhone 15", "iPhone 16 Pro", "ThinkPad T14"
  const modelMatch = text.match(/\b(iPhone\s+\d+(?:\s+Pro|\s+Max)?|ThinkPad\s+[A-Z0-9]+|Latitude\s+\d+)\b/i);
  if (modelMatch) {
    return { model: modelMatch[1] };
  }

  return null;
}

/**
 * Check if a message contains multiple separate requirements
 * e.g., "I need laptops and office chairs"
 */
export function detectMultipleRequirements(text: string): {
  isMultiple: boolean;
  subRequirements: string[];
} {
  const lower = text.toLowerCase();
  // Check for conjunctions connecting distinct items
  // e.g. "laptops and office chairs", "cybersecurity and housekeeping"
  const multiPattern = /\b(i need|we need)\s+(.+?)\s+and\s+(.+?)(?:$|\.|\,)/i;
  const match = lower.match(multiPattern);

  if (match) {
    const first = match[2].trim();
    const second = match[3].trim();

    // Check if both parts map to different categories
    const cat1 = extractRequirement(first).category;
    const cat2 = extractRequirement(second).category;

    if (cat1 && cat2 && cat1 !== cat2) {
      return {
        isMultiple: true,
        subRequirements: [first, second],
      };
    }
  }

  return {
    isMultiple: false,
    subRequirements: [],
  };
}

function capitalizeWords(str: string): string {
  return str
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
