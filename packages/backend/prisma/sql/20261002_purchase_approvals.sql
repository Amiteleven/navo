-- Manager approval & purchase authorization.
--
-- NAVO has no migration history (`prisma db push` is the project's workflow, see
-- package.json `db:push`), so this file exists for environments where an
-- operator must apply DDL explicitly. It is written to be re-runnable: every
-- object is created only if absent.
--
-- Apply with:  psql "$DATABASE_URL" -f packages/backend/prisma/sql/20261002_purchase_approvals.sql

-- ── Enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "PurchaseApprovalStatus" AS ENUM (
    'PENDING_APPROVAL', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED',
    'PURCHASE_CONFIRMED', 'CANCELLED', 'SUPERSEDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PurchaseApprovalDecisionStatus" AS ENUM (
    'PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'SKIPPED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PurchaseApprovalChangeTrigger" AS ENUM (
    'PRICE_INCREASE', 'PRICE_DECREASE', 'QUANTITY_CHANGE',
    'DELIVERY_TERMS_CHANGE', 'PAYMENT_TERMS_CHANGE', 'OTHER_TERMS_CHANGE',
    'POLICY_CHANGE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A selected offer awaiting authorization is not yet a commitment.
ALTER TYPE "DealOfferStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'APPROVAL_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'APPROVAL_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'APPROVAL_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'APPROVAL_CHANGES_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PURCHASE_CONFIRMED';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPROVAL_POLICY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'APPROVAL_RULE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_AUTO_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_CHANGES_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_REASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_INVALIDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_APPROVAL_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_CONFIRMED';

-- ── Organizational attributes the approval rules scope on ─────────────────────

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "department" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "costCenter" TEXT;
ALTER TABLE "ProcurementRequest" ADD COLUMN IF NOT EXISTS "department" TEXT;
ALTER TABLE "ProcurementRequest" ADD COLUMN IF NOT EXISTS "costCenter" TEXT;

CREATE INDEX IF NOT EXISTS "User_department_idx" ON "User"("department");

-- ── Purchase approval configuration ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "PurchaseApprovalPolicy" (
  "id"                                    TEXT NOT NULL,
  "tenantId"                              TEXT NOT NULL,
  "name"                                  TEXT NOT NULL DEFAULT 'Purchase approval policy',
  "description"                           TEXT,
  "currency"                              TEXT NOT NULL DEFAULT 'INR',
  "isActive"                              BOOLEAN NOT NULL DEFAULT true,
  "version"                               INTEGER NOT NULL DEFAULT 1,
  "includeTaxesInThreshold"               BOOLEAN NOT NULL DEFAULT true,
  "includeDeliveryChargesInThreshold"     BOOLEAN NOT NULL DEFAULT true,
  "autoApproveBelowAmount"                DECIMAL(18,4),
  "allowSelfApproval"                     BOOLEAN NOT NULL DEFAULT false,
  "selfApprovalJustification"             TEXT,
  "reapprovalRules"                       JSONB,
  "splitGuardEnabled"                     BOOLEAN NOT NULL DEFAULT true,
  "splitGuardWindowDays"                  INTEGER NOT NULL DEFAULT 30,
  "updatedById"                           TEXT,
  "createdAt"                             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseApprovalPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseApprovalPolicy_tenantId_key" ON "PurchaseApprovalPolicy"("tenantId");

CREATE TABLE IF NOT EXISTS "PurchaseApprovalRule" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "policyId"       TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "priority"       INTEGER NOT NULL DEFAULT 100,
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "minAmount"      DECIMAL(18,4),
  "maxAmount"      DECIMAL(18,4),
  "department"     TEXT,
  "categoryId"     TEXT,
  "costCenter"     TEXT,
  "requireApproval" BOOLEAN NOT NULL DEFAULT true,
  "levels"         JSONB NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseApprovalRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PurchaseApprovalRule_tenantId_isActive_priority_idx"
  ON "PurchaseApprovalRule"("tenantId", "isActive", "priority");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRule_policyId_idx" ON "PurchaseApprovalRule"("policyId");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRule_categoryId_idx" ON "PurchaseApprovalRule"("categoryId");

-- ── The authorization request and its levels ──────────────────────────────────

CREATE TABLE IF NOT EXISTS "PurchaseApprovalRequest" (
  "id"                          TEXT NOT NULL,
  "reference"                   TEXT NOT NULL,
  "tenantId"                    TEXT NOT NULL,
  "requestId"                   TEXT NOT NULL,
  "vendorId"                    TEXT NOT NULL,
  "dealRoomId"                  TEXT,
  "dealId"                      TEXT,
  "offerId"                     TEXT NOT NULL,
  "quoteId"                     TEXT,
  "submittedById"               TEXT NOT NULL,
  "status"                      "PurchaseApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
  "currency"                    TEXT NOT NULL DEFAULT 'INR',
  "unitPrice"                   DECIMAL(18,4) NOT NULL,
  "quantity"                    INTEGER NOT NULL,
  "taxRate"                     DECIMAL(9,4) NOT NULL DEFAULT 0,
  "taxAmount"                   DECIMAL(18,4) NOT NULL DEFAULT 0,
  "freightAmount"               DECIMAL(18,4) NOT NULL DEFAULT 0,
  "installationAmount"          DECIMAL(18,4) NOT NULL DEFAULT 0,
  "otherCharges"                DECIMAL(18,4) NOT NULL DEFAULT 0,
  "subtotal"                    DECIMAL(18,4) NOT NULL,
  "totalAmount"                 DECIMAL(18,4) NOT NULL,
  "thresholdAmount"             DECIMAL(18,4) NOT NULL,
  "paymentTerms"                TEXT,
  "deliveryTimelineDays"        INTEGER,
  "warrantyMonths"              INTEGER,
  "deliverySchedule"            TEXT,
  "otherChargesDetails"         TEXT,
  "documents"                   JSONB,
  "policyId"                    TEXT,
  "policyVersion"               INTEGER,
  "appliedRuleId"               TEXT,
  "policySnapshot"              JSONB,
  "ruleSnapshot"                JSONB,
  "requesterComment"            TEXT,
  "negotiationSnapshot"         JSONB,
  "currentLevel"                INTEGER NOT NULL DEFAULT 1,
  "revision"                    INTEGER NOT NULL DEFAULT 1,
  "parentRequestId"             TEXT,
  "supersededById"              TEXT,
  "supersedeReason"             TEXT,
  "supersededAt"                TIMESTAMP(3),
  "decidedAt"                   TIMESTAMP(3),
  "purchaseConfirmedAt"         TIMESTAMP(3),
  "purchaseConfirmedById"       TEXT,
  "purchaseOrderId"             TEXT,
  "cancelledAt"                 TIMESTAMP(3),
  "cancelReason"                TEXT,
  "dueAt"                       TIMESTAMP(3),
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseApprovalRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseApprovalRequest_reference_tenantId_key"
  ON "PurchaseApprovalRequest"("reference", "tenantId");
-- One live authorization per offer: the guard against a buyer submitting the
-- same negotiated offer twice to obtain two approval chains.
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseApprovalRequest_offerId_tenantId_key"
  ON "PurchaseApprovalRequest"("offerId", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseApprovalRequest_dealId_key"
  ON "PurchaseApprovalRequest"("dealId");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseApprovalRequest_purchaseOrderId_key"
  ON "PurchaseApprovalRequest"("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRequest_tenantId_status_idx"
  ON "PurchaseApprovalRequest"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRequest_requestId_status_idx"
  ON "PurchaseApprovalRequest"("requestId", "status");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRequest_submittedById_status_idx"
  ON "PurchaseApprovalRequest"("submittedById", "status");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRequest_vendorId_idx" ON "PurchaseApprovalRequest"("vendorId");

CREATE TABLE IF NOT EXISTS "PurchaseApprovalDecision" (
  "id"                       TEXT NOT NULL,
  "tenantId"                 TEXT NOT NULL,
  "purchaseApprovalRequestId" TEXT NOT NULL,
  "level"                    INTEGER NOT NULL,
  "requiredRole"             "UserRole" NOT NULL,
  "label"                    TEXT,
  "status"                   "PurchaseApprovalDecisionStatus" NOT NULL DEFAULT 'PENDING',
  "assignedApproverId"       TEXT,
  "delegatedFromApproverId"  TEXT,
  "delegationReason"         TEXT,
  "decidedById"              TEXT,
  "comments"                 TEXT,
  "decidedAt"                TIMESTAMP(3),
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PurchaseApprovalDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseApprovalDecision_purchaseApprovalRequestId_level_key"
  ON "PurchaseApprovalDecision"("purchaseApprovalRequestId", "level");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalDecision_tenantId_status_idx"
  ON "PurchaseApprovalDecision"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalDecision_assignedApproverId_status_idx"
  ON "PurchaseApprovalDecision"("assignedApproverId", "status");

CREATE TABLE IF NOT EXISTS "PurchaseApprovalAssignment" (
  "id"             TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "decisionId"     TEXT NOT NULL,
  "fromApproverId" TEXT,
  "toApproverId"   TEXT NOT NULL,
  "reason"         TEXT NOT NULL,
  "createdById"    TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PurchaseApprovalAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PurchaseApprovalAssignment_tenantId_idx" ON "PurchaseApprovalAssignment"("tenantId");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalAssignment_decisionId_idx" ON "PurchaseApprovalAssignment"("decisionId");
CREATE INDEX IF NOT EXISTS "PurchaseApprovalAssignment_toApproverId_idx" ON "PurchaseApprovalAssignment"("toApproverId");

-- ── Foreign keys ──────────────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalPolicy" ADD CONSTRAINT "PurchaseApprovalPolicy_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRule" ADD CONSTRAINT "PurchaseApprovalRule_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRule" ADD CONSTRAINT "PurchaseApprovalRule_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "PurchaseApprovalPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRule" ADD CONSTRAINT "PurchaseApprovalRule_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "ProcurementRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_dealRoomId_fkey"
    FOREIGN KEY ("dealRoomId") REFERENCES "DealRoom"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_dealId_fkey"
    FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "DealOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_policyId_fkey"
    FOREIGN KEY ("policyId") REFERENCES "PurchaseApprovalPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_appliedRuleId_fkey"
    FOREIGN KEY ("appliedRuleId") REFERENCES "PurchaseApprovalRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_submittedById_fkey"
    FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_purchaseConfirmedById_fkey"
    FOREIGN KEY ("purchaseConfirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalRequest" ADD CONSTRAINT "PurchaseApprovalRequest_purchaseOrderId_fkey"
    FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalDecision" ADD CONSTRAINT "PurchaseApprovalDecision_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalDecision" ADD CONSTRAINT "PurchaseApprovalDecision_purchaseApprovalRequestId_fkey"
    FOREIGN KEY ("purchaseApprovalRequestId") REFERENCES "PurchaseApprovalRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalDecision" ADD CONSTRAINT "PurchaseApprovalDecision_assignedApproverId_fkey"
    FOREIGN KEY ("assignedApproverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalDecision" ADD CONSTRAINT "PurchaseApprovalDecision_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalAssignment" ADD CONSTRAINT "PurchaseApprovalAssignment_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalAssignment" ADD CONSTRAINT "PurchaseApprovalAssignment_decisionId_fkey"
    FOREIGN KEY ("decisionId") REFERENCES "PurchaseApprovalDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalAssignment" ADD CONSTRAINT "PurchaseApprovalAssignment_toApproverId_fkey"
    FOREIGN KEY ("toApproverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "PurchaseApprovalAssignment" ADD CONSTRAINT "PurchaseApprovalAssignment_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Purchase order linkage ───────────────────────────────────────────────────

ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "approvalRequestId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_approvalRequestId_key"
  ON "PurchaseOrder"("approvalRequestId");
CREATE INDEX IF NOT EXISTS "PurchaseOrder_approvalRequestId_idx"
  ON "PurchaseOrder"("approvalRequestId");

DO $$ BEGIN
  ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_approvalRequestId_fkey"
    FOREIGN KEY ("approvalRequestId") REFERENCES "PurchaseApprovalRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── In-app notification deduplication ─────────────────────────────────────────

-- A repeated trigger loses the insert race rather than showing the same alert
-- twice. Nullable, so notifications written before this column keep working.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- ── Split-purchase guard support ──────────────────────────────────────────────
--
-- The guard compares submitter + vendor + item inside a rolling window, which is
-- a lookup the service must run on every submission.
CREATE INDEX IF NOT EXISTS "PurchaseApprovalRequest_submitter_vendor_idx"
  ON "PurchaseApprovalRequest"("tenantId", "submittedById", "vendorId");
