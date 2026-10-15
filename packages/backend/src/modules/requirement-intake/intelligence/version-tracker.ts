/**
 * NAVO Requirement Intelligence Engine — Version Tracker & Material Change Detector
 *
 * Implements requirement versioning (V1, V2, V3...), audit trail generation,
 * natural language edit diffing, and post-approval material change reapproval evaluation.
 */

import { MaterialChangeEvaluation, VersionSnapshot } from './types.js';
import prisma from '../../../utils/prisma.js';

export interface DiffResult {
  hasChanges: boolean;
  isMaterial: boolean;
  changedFields: string[];
  changeSummary: string;
}

export function detectRequirementDiff(
  oldDraft: Record<string, any>,
  newDraft: Record<string, any>
): DiffResult {
  const changedFields: string[] = [];
  const summaryParts: string[] = [];
  let isMaterial = false;

  // Quantity change: "Quantity updated from 50 to 75"
  if (newDraft.quantity !== undefined && newDraft.quantity !== oldDraft.quantity) {
    changedFields.push('quantity');
    summaryParts.push(`Quantity updated from ${oldDraft.quantity || 'unspecified'} to ${newDraft.quantity}`);
    const ratio = oldDraft.quantity ? Math.abs(newDraft.quantity - oldDraft.quantity) / oldDraft.quantity : 1;
    if (ratio >= 0.2) isMaterial = true; // > 20% quantity jump is material
  }

  // Location change: "Location changed from Mumbai to Pune"
  const oldLoc = oldDraft.location || oldDraft.deliveryLocation;
  const newLoc = newDraft.location || newDraft.deliveryLocation;
  if (newLoc && newLoc !== oldLoc) {
    changedFields.push('location');
    summaryParts.push(`Delivery location changed from ${oldLoc || 'unspecified'} to ${newLoc}`);
    isMaterial = true; // Location change is typically material for logistics
  }

  // Budget change: "Budget updated to ₹12,00,000"
  const oldBudget = oldDraft.budget ? Number(oldDraft.budget) : (oldDraft.estimatedBudget ? Number(oldDraft.estimatedBudget) : undefined);
  const newBudget = newDraft.budget ? Number(newDraft.budget) : (newDraft.estimatedBudget ? Number(newDraft.estimatedBudget) : undefined);
  if (newBudget !== undefined && newBudget !== oldBudget) {
    changedFields.push('budget');
    const curr = newDraft.currency || oldDraft.currency || 'INR';
    summaryParts.push(`Budget updated from ${oldBudget ? `${curr} ${oldBudget}` : 'none'} to ${curr} ${newBudget}`);
    if (!oldBudget || newBudget > oldBudget * 1.15) {
      isMaterial = true; // > 15% increase is material
    }
  }

  // Specifications / Warranty changes
  const oldSpecs = (typeof oldDraft.specifications === 'object' && oldDraft.specifications) ? oldDraft.specifications : {};
  const newSpecs = (typeof newDraft.specifications === 'object' && newDraft.specifications) ? newDraft.specifications : {};

  // Warranty: "Added 5-year warranty requirement", "Removed warranty requirement"
  const oldWarranty = oldSpecs.warranty || oldDraft.warranty;
  const newWarranty = newSpecs.warranty || newDraft.warranty;
  if (newWarranty !== oldWarranty) {
    changedFields.push('warranty');
    if (!newWarranty || newWarranty === 'removed') {
      summaryParts.push('Removed warranty requirement');
    } else {
      summaryParts.push(`Added warranty requirement: ${newWarranty}`);
    }
  }

  // Item change:
  if (newDraft.item && newDraft.item !== oldDraft.item) {
    changedFields.push('item');
    summaryParts.push(`Item updated from "${oldDraft.item}" to "${newDraft.item}"`);
    isMaterial = true;
  }

  // Service Duration change: "12-month service -> 36-month service"
  if (newDraft.serviceDuration && newDraft.serviceDuration !== oldDraft.serviceDuration) {
    changedFields.push('serviceDuration');
    summaryParts.push(`Service duration updated to ${newDraft.serviceDuration}`);
    isMaterial = true;
  }

  const hasChanges = changedFields.length > 0;
  const changeSummary = summaryParts.length > 0 ? summaryParts.join('; ') : 'Requirement updated';

  return {
    hasChanges,
    isMaterial,
    changedFields,
    changeSummary,
  };
}

/**
 * Persist a new version for a requirement draft
 */
export async function recordDraftVersion(params: {
  draftId: string;
  currentVersion: number;
  changeSummary: string;
  changedFields: string[];
  snapshot: Record<string, any>;
  userId?: string;
}): Promise<number> {
  const { draftId, currentVersion, changeSummary, changedFields, snapshot, userId } = params;
  const nextVersion = currentVersion + 1;

  await prisma.requirementDraftVersion.create({
    data: {
      draftId,
      versionNumber: nextVersion,
      changeSummary,
      changedFields,
      snapshot,
      changedById: userId,
    },
  });

  await prisma.requirementDraft.update({
    where: { id: draftId },
    data: {
      version: nextVersion,
      updatedAt: new Date(),
    },
  });

  return nextVersion;
}

/**
 * Get all versions for a draft
 */
export async function getDraftVersionHistory(draftId: string): Promise<VersionSnapshot[]> {
  const records = await prisma.requirementDraftVersion.findMany({
    where: { draftId },
    orderBy: { versionNumber: 'desc' },
  });

  return records.map((r) => ({
    versionNumber: r.versionNumber,
    changeSummary: r.changeSummary,
    changedFields: r.changedFields,
    snapshot: r.snapshot as Record<string, any>,
    changedById: r.changedById ?? undefined,
    createdAt: r.createdAt,
  }));
}

/**
 * Evaluate if a change made to an APPROVED requirement requires re-approval
 */
export function evaluatePostApprovalReapproval(
  oldApprovedReq: Record<string, any>,
  newDraft: Record<string, any>,
  thresholdBudgetPct: number = 15 // Configurable threshold (default 15%)
): MaterialChangeEvaluation {
  const changes: Array<{ field: string; oldValue: any; newValue: any; isMaterial: boolean }> = [];
  let requiresReapproval = false;
  const reasons: string[] = [];

  // 1. Budget increase check
  const oldBudget = Number(oldApprovedReq.estimatedBudget || oldApprovedReq.budget || 0);
  const newBudget = Number(newDraft.estimatedBudget || newDraft.budget || 0);
  if (newBudget > oldBudget && oldBudget > 0) {
    const pctIncrease = ((newBudget - oldBudget) / oldBudget) * 100;
    const isBudgetMaterial = pctIncrease > thresholdBudgetPct;
    changes.push({ field: 'estimatedBudget', oldValue: oldBudget, newValue: newBudget, isMaterial: isBudgetMaterial });
    if (isBudgetMaterial) {
      requiresReapproval = true;
      reasons.push(`Budget increased by ${pctIncrease.toFixed(1)}% (exceeds ${thresholdBudgetPct}% threshold)`);
    }
  }

  // 2. Quantity check (surge > 20%)
  const oldQty = oldApprovedReq.quantity;
  const newQty = newDraft.quantity;
  if (oldQty && newQty && newQty !== oldQty) {
    const qtyChangePct = (Math.abs(newQty - oldQty) / oldQty) * 100;
    const isQtyMaterial = qtyChangePct > 20;
    changes.push({ field: 'quantity', oldValue: oldQty, newValue: newQty, isMaterial: isQtyMaterial });
    if (isQtyMaterial) {
      requiresReapproval = true;
      reasons.push(`Quantity changed from ${oldQty} to ${newQty} (${qtyChangePct.toFixed(1)}% shift)`);
    }
  }

  // 3. Location change
  const oldLoc = oldApprovedReq.location;
  const newLoc = newDraft.location || newDraft.deliveryLocation;
  if (oldLoc && newLoc && oldLoc.toLowerCase() !== newLoc.toLowerCase()) {
    changes.push({ field: 'location', oldValue: oldLoc, newValue: newLoc, isMaterial: true });
    requiresReapproval = true;
    reasons.push(`Delivery location changed from ${oldLoc} to ${newLoc}`);
  }

  return {
    isMaterial: changes.some((c) => c.isMaterial),
    requiresReapproval,
    reason: reasons.join('; ') || undefined,
    changes,
  };
}
