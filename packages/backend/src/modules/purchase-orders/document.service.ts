import { Prisma } from '@prisma/client';
import { AuditAction, DocumentCategory, InvoiceStatus, PurchaseOrderStatus, UserRole } from '@navo/shared';
import prisma from '../../utils/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { createAuditLog } from '../audit/audit.service.js';
import { ActorContext, loadAccessiblePo, requireSeller } from './po-access.js';

/**
 * Document storage.
 *
 * Bytes are stored in the database rather than on disk or object storage so a
 * document is never reachable by guessing a URL: every read goes through a
 * tenant- and role-scoped lookup first.
 */

/** 10 MB ceiling - generous for scans and PDFs, bounded to protect the DB. */
export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]);

/** Suppliers may only upload invoice- or delivery-related categories. */
const SELLER_CATEGORIES = new Set([
  DocumentCategory.INVOICE,
  DocumentCategory.TAX_INVOICE,
  DocumentCategory.DELIVERY_NOTE,
  DocumentCategory.PROOF_OF_DELIVERY,
  DocumentCategory.SUPPORTING,
]);

export interface UploadDocumentInput {
  poId?: string;
  invoiceId?: string;
  category: DocumentCategory;
  fileName: string;
  mimeType: string;
  content: Buffer;
}

export async function uploadDocument(actor: ActorContext, input: UploadDocumentInput) {
  if (!input.poId && !input.invoiceId) {
    throw new ValidationError('A document must be attached to a purchase order or an invoice');
  }
  if (!input.fileName?.trim()) {
    throw new ValidationError('fileName is required');
  }
  if (!input.content?.length) {
    throw new ValidationError('The uploaded file is empty');
  }
  if (input.content.length > MAX_DOCUMENT_SIZE) {
    throw new ValidationError(
      `File exceeds the ${Math.floor(MAX_DOCUMENT_SIZE / 1024 / 1024)} MB limit`,
    );
  }
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new ValidationError(`Unsupported file type: ${input.mimeType}`);
  }

  if (actor.role === UserRole.VENDOR && !SELLER_CATEGORIES.has(input.category)) {
    throw new ForbiddenError('Suppliers may only upload invoice and delivery documents');
  }

  // Authorize against the parent PO regardless of whether the caller supplied
  // it, so a seller cannot attach a document to another supplier's order by
  // passing only an invoiceId.
  const anchorPoId = input.poId ?? (await resolvePoIdForInvoice(input.invoiceId!));
  if (!anchorPoId) {
    throw new ValidationError('Document is not linked to a purchase order');
  }
  const po = await loadAccessiblePo(anchorPoId, actor);

  if (po.status === PurchaseOrderStatus.CANCELLED) {
    throw new ForbiddenError('Cannot attach documents to a cancelled purchase order');
  }

  if (input.invoiceId) {
    const invoice = await prisma.invoice.findFirst({
      where: { id: input.invoiceId, poId: po.id },
      select: { id: true },
    });
    if (!invoice) throw new ValidationError('Invoice does not belong to this purchase order');
  }

  const document = await prisma.document.create({
    data: {
      poId: po.id,
      invoiceId: input.invoiceId ?? null,
      category: input.category,
      fileName: sanitizeFileName(input.fileName),
      mimeType: input.mimeType,
      size: input.content.length,
      // Buffer satisfies Prisma's Bytes mapping directly.
      content: input.content,
      uploadedById: actor.userId,
      tenantId: actor.tenantId,
    },
    select: {
      id: true,
      poId: true,
      invoiceId: true,
      category: true,
      fileName: true,
      mimeType: true,
      size: true,
      uploadedById: true,
      createdAt: true,
    },
  });

  // Keep the parent records' document id lists in sync so the invoice and PO
  // detail views can list attachments without a second query per row.
  if (input.invoiceId) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: input.invoiceId },
      select: { documentIds: true },
    });
    await prisma.invoice.update({
      where: { id: input.invoiceId },
      data: { documentIds: [...(invoice?.documentIds ?? []), document.id] },
    });
  }

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.DOCUMENT_UPLOADED,
    entityType: 'Document',
    entityId: document.id,
    tenantId: actor.tenantId,
    metadata: {
      poId: po.id,
      poNumber: po.poNumber,
      invoiceId: input.invoiceId,
      category: input.category,
      fileName: document.fileName,
      size: document.size,
      mimeType: document.mimeType,
    },
  });

  return document;
}

/** Fetch document bytes after an authorization check. */
export async function getDocumentContent(documentId: string, actor: ActorContext) {
  const document = await prisma.document.findFirst({
    where: { id: documentId, tenantId: actor.tenantId },
    select: {
      id: true,
      poId: true,
      invoiceId: true,
      category: true,
      fileName: true,
      mimeType: true,
      size: true,
      content: true,
      tenantId: true,
    },
  });

  if (!document) throw new NotFoundError('Document');

  // Authorization is anchored on the PO for every document, including ones
  // attached only to an invoice.
  const anchorPoId = document.poId ?? (document.invoiceId ? await resolvePoIdForInvoice(document.invoiceId) : null);
  if (!anchorPoId) {
    throw new ForbiddenError('Document is not linked to a purchase order');
  }
  await loadAccessiblePo(anchorPoId, actor);

  await createAuditLog({
    userId: actor.userId,
    action: AuditAction.DOCUMENT_DOWNLOADED,
    entityType: 'Document',
    entityId: document.id,
    tenantId: actor.tenantId,
    metadata: { poId: anchorPoId, fileName: document.fileName, category: document.category },
  });

  return {
    content: Buffer.from(document.content as Uint8Array),
    fileName: document.fileName,
    mimeType: document.mimeType,
    size: document.size,
  };
}

export async function listDocuments(
  actor: ActorContext,
  filters: { poId?: string; invoiceId?: string; category?: DocumentCategory } = {},
) {
  const where: Prisma.DocumentWhereInput = { tenantId: actor.tenantId };

  if (filters.invoiceId) where.invoiceId = filters.invoiceId;
  if (filters.category) where.category = filters.category;

  if (filters.poId) {
    await loadAccessiblePo(filters.poId, actor);
    where.poId = filters.poId;
  } else if (actor.role === UserRole.VENDOR) {
    const seller = await requireSeller(actor.userId, actor.tenantId);
    where.po = { vendorId: seller.vendorId };
  }

  return prisma.document.findMany({
    where,
    select: {
      id: true,
      poId: true,
      invoiceId: true,
      category: true,
      fileName: true,
      mimeType: true,
      size: true,
      uploadedById: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function resolvePoIdForInvoice(invoiceId: string): Promise<string | null> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { poId: true } });
  return invoice?.poId ?? null;
}

/**
 * Strip path components and control characters from an uploaded file name so a
 * stored name can never be used for path traversal or header injection when the
 * file is downloaded.
 */
function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'document';
  return base.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'document';
}

export { InvoiceStatus };