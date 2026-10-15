import { prisma } from './prisma.js';

/**
 * Human-readable document numbering: PO-2026-0001, GR-2026-0001, PAR-2026-0001.
 *
 * These numbers are assigned by counting existing rows for the year, which is
 * unsafe under concurrency: two requests can read the same count and attempt the
 * same number. The `@unique` constraint on the column is the only thing that
 * prevents duplicates, so generation retries on conflict. To keep the retry
 * loop short, the sequence restarts per year and reuses a gap immediately.
 */

const MAX_ATTEMPTS = 10;

/** Every document series NAVO numbers, and where its numbers live. */
const SERIES = {
  PO: { table: 'purchaseOrder', column: 'poNumber' },
  GR: { table: 'goodsReceipt', column: 'receiptNumber' },
  /** Purchase approval requests, so a request can be cited in an audit review. */
  PAR: { table: 'purchaseApprovalRequest', column: 'reference' },
} as const;

export type DocumentSeries = keyof typeof SERIES;

/** Zero-pad a sequence number to 4 digits. */
function pad(sequence: number): string {
  return String(sequence).padStart(4, '0');
}

/**
 * Allocate the next document number for `prefix` within `year`.
 *
 * Scoped by tenant so two tenants never share a number space, and the sequence
 * is derived from the rows that already exist for this tenant+prefix+year.
 */
export async function nextDocumentNumber(
  prefix: DocumentSeries,
  tenantId: string,
  date: Date = new Date(),
): Promise<string> {
  const year = date.getFullYear();
  const stem = `${prefix}-${year}-`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const count = await countExisting(prefix, tenantId, stem);

    // Re-scan once to consume any gap left by a rolled-back transaction, so a
    // single failure does not permanently skip a number.
    const candidate = (await lowestGap(prefix, tenantId, stem, count)) ?? count + 1;
    if (candidate > 9999) {
      throw new Error(`${prefix} sequence exhausted for ${year}`);
    }
    const number = `${stem}${pad(candidate)}`;
    if (!(await numberExists(prefix, tenantId, number))) {
      return number;
    }
  }

  throw new Error(`Could not allocate a unique ${prefix} number for ${year}`);
}

/**
 * Prisma's delegates are not indexable by a computed key with a compatible
 * type, so the three series are dispatched explicitly. Narrowing the key here
 * keeps the query type-checked instead of erased through `any`.
 */
async function countExisting(prefix: DocumentSeries, tenantId: string, stem: string): Promise<number> {
  switch (prefix) {
    case 'PO':
      return prisma.purchaseOrder.count({ where: { tenantId, poNumber: { startsWith: stem } } });
    case 'GR':
      return prisma.goodsReceipt.count({ where: { tenantId, receiptNumber: { startsWith: stem } } });
    case 'PAR':
      return prisma.purchaseApprovalRequest.count({ where: { tenantId, reference: { startsWith: stem } } });
  }
}

async function numberExists(prefix: DocumentSeries, tenantId: string, number: string): Promise<boolean> {
  switch (prefix) {
    case 'PO':
      return (await prisma.purchaseOrder.count({ where: { tenantId, poNumber: number } })) > 0;
    case 'GR':
      return (await prisma.goodsReceipt.count({ where: { tenantId, receiptNumber: number } })) > 0;
    case 'PAR':
      return (await prisma.purchaseApprovalRequest.count({ where: { tenantId, reference: number } })) > 0;
  }
}

/**
 * Return the first unallocated sequence number in 1..count, or undefined when
 * the range is contiguous. Closes gaps left by cancelled or rolled-back rows.
 */
async function lowestGap(
  prefix: DocumentSeries,
  tenantId: string,
  stem: string,
  count: number,
): Promise<number | undefined> {
  if (count === 0) return undefined;

  let numbers: string[];
  switch (prefix) {
    case 'PO':
      numbers = (
        await prisma.purchaseOrder.findMany({
          where: { tenantId, poNumber: { startsWith: stem } },
          select: { poNumber: true },
        })
      ).map((r) => r.poNumber);
      break;
    case 'GR':
      numbers = (
        await prisma.goodsReceipt.findMany({
          where: { tenantId, receiptNumber: { startsWith: stem } },
          select: { receiptNumber: true },
        })
      ).map((r) => r.receiptNumber);
      break;
    case 'PAR':
      numbers = (
        await prisma.purchaseApprovalRequest.findMany({
          where: { tenantId, reference: { startsWith: stem } },
          select: { reference: true },
        })
      ).map((r) => r.reference);
      break;
  }

  const taken = new Set(numbers.map((value) => Number(value.slice(stem.length))));
  for (let i = 1; i <= count; i++) {
    if (!taken.has(i)) return i;
  }
  return undefined;
}