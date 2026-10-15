-- Demo purchase-approval configuration for the `demo-corp` tenant.
--
-- The approval tables exist but the demo tenant has no policy, so every
-- submission currently fails closed with "no rule matched" and nothing can ever
-- be approved. This installs a realistic two-band policy and the request that
-- exercises it, so the inbox, the chain, and the confirm step have something
-- real to act on.
--
-- Re-runnable: every insert is guarded by ON CONFLICT / NOT EXISTS.
--
-- Apply with:
--   psql "$DATABASE_URL" -f packages/backend/prisma/sql/20261002_purchase_approvals_seed.sql
--
-- NOTE: this writes to a shared database. Take a backup first if the tenant
-- already holds live approvals.

-- No psql meta-commands here on purpose: the file is also runnable through
-- `prisma db execute --stdin`, which rejects backslash directives.

BEGIN;

-- ── Resolve the demo tenant ───────────────────────────────────────────────────
-- The policy is keyed by tenant, so it is addressed by slug rather than by a
-- hardcoded id that would differ between environments.

DO $$
DECLARE
  v_tenant_id TEXT;
BEGIN
  SELECT "id" INTO v_tenant_id FROM "Tenant" WHERE "slug" = 'demo-corp';

  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant demo-corp not found - run prisma/seed.ts first';
  END IF;

  -- ── The policy ──────────────────────────────────────────────────────────────
  --
  -- autoApproveBelowAmount is deliberately non-null: without a small-purchase
  -- allowance every purchase needs a manager, which makes the workflow look
  -- broken rather than strict. 50,000 INR keeps ordinary buying unblocked while
  -- leaving the seeded request (well above it) in approval.
  --
  -- allowSelfApproval stays false. It is the single most dangerous field here,
  -- and a demo tenant should not ship with a buyer able to authorize their own
  -- spend.

  INSERT INTO "PurchaseApprovalPolicy" (
    "id", "tenantId", "name", "description", "currency", "isActive", "version",
    "includeTaxesInThreshold", "includeDeliveryChargesInThreshold",
    "autoApproveBelowAmount", "allowSelfApproval", "selfApprovalJustification",
    "reapprovalRules", "splitGuardEnabled", "splitGuardWindowDays",
    "createdAt", "updatedAt"
  )
  VALUES (
    'pa_policy_demo_corp',
    v_tenant_id,
    'Demo purchase approval policy',
    'Two-band authorization: manager sign-off up to 500k, manager plus finance above it.',
    'INR',
    true,
    1,
    true,
    true,
    50000.0000,
    false,
    NULL,
    '{"priceIncrease":true,"priceDecrease":false,"quantity":true,"deliveryTerms":true,"paymentTerms":true}'::jsonb,
    true,
    30,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT ("tenantId") DO UPDATE SET
    "name"                              = EXCLUDED."name",
    "description"                       = EXCLUDED."description",
    "currency"                          = EXCLUDED."currency",
    "isActive"                          = EXCLUDED."isActive",
    "includeTaxesInThreshold"           = EXCLUDED."includeTaxesInThreshold",
    "includeDeliveryChargesInThreshold" = EXCLUDED."includeDeliveryChargesInThreshold",
    "autoApproveBelowAmount"            = EXCLUDED."autoApproveBelowAmount",
    "allowSelfApproval"                 = EXCLUDED."allowSelfApproval",
    "reapprovalRules"                   = EXCLUDED."reapprovalRules",
    "splitGuardEnabled"                 = EXCLUDED."splitGuardEnabled",
    "splitGuardWindowDays"              = EXCLUDED."splitGuardWindowDays",
    "updatedAt"                         = CURRENT_TIMESTAMP;

  -- Bumping the version matters: it is what tells an already-submitted request
  -- that the policy underneath it changed.
  UPDATE "PurchaseApprovalPolicy"
     SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
   WHERE "tenantId" = v_tenant_id;

  -- ── Rules ───────────────────────────────────────────────────────────────────
  --
  -- Bands are [min, max): 50k-500k and 500k+. Priority breaks ties, lowest
  -- first. The rules deliberately carry no department/category/cost-center, so
  -- they match every purchase; scoping is left to the operator.
  --
  -- `levels` must list requiredRole from the assignable set only
  -- (PLATFORM_ADMIN, COMPANY_ADMIN, PROCUREMENT_MANAGER, FINANCE_APPROVER).
  -- Anything else is silently dropped by normalizeLevels(), which would leave a
  -- level with no approver and stall the request.

  INSERT INTO "PurchaseApprovalRule" (
    "id", "tenantId", "policyId", "name", "priority", "isActive",
    "minAmount", "maxAmount", "department", "categoryId", "costCenter",
    "requireApproval", "levels", "createdAt", "updatedAt"
  )
  SELECT
    'pa_rule_mid_demo_corp',
    v_tenant_id,
    p."id",
    'Manager approval, 50k to 500k',
    10,
    true,
    50000.0000,
    500000.0000,
    NULL, NULL, NULL,
    true,
    '[{"level":1,"requiredRole":"PROCUREMENT_MANAGER","label":"Procurement manager review"}]'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM "PurchaseApprovalPolicy" p
  WHERE p."tenantId" = v_tenant_id
  ON CONFLICT ("id") DO UPDATE SET
    "name"           = EXCLUDED."name",
    "priority"       = EXCLUDED."priority",
    "isActive"       = EXCLUDED."isActive",
    "minAmount"      = EXCLUDED."minAmount",
    "maxAmount"      = EXCLUDED."maxAmount",
    "requireApproval"= EXCLUDED."requireApproval",
    "levels"         = EXCLUDED."levels",
    "updatedAt"      = CURRENT_TIMESTAMP;

  INSERT INTO "PurchaseApprovalRule" (
    "id", "tenantId", "policyId", "name", "priority", "isActive",
    "minAmount", "maxAmount", "department", "categoryId", "costCenter",
    "requireApproval", "levels", "createdAt", "updatedAt"
  )
  SELECT
    'pa_rule_high_demo_corp',
    v_tenant_id,
    p."id",
    'Manager plus finance approval, above 500k',
    20,
    true,
    500000.0000,
    NULL,
    NULL, NULL, NULL,
    true,
    '[{"level":1,"requiredRole":"PROCUREMENT_MANAGER","label":"Procurement manager review"},
      {"level":2,"requiredRole":"FINANCE_APPROVER","label":"Finance review"}]'::jsonb,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM "PurchaseApprovalPolicy" p
  WHERE p."tenantId" = v_tenant_id
  ON CONFLICT ("id") DO UPDATE SET
    "name"           = EXCLUDED."name",
    "priority"       = EXCLUDED."priority",
    "isActive"       = EXCLUDED."isActive",
    "minAmount"      = EXCLUDED."minAmount",
    "maxAmount"      = EXCLUDED."maxAmount",
    "requireApproval"= EXCLUDED."requireApproval",
    "levels"         = EXCLUDED."levels",
    "updatedAt"      = CURRENT_TIMESTAMP;

  -- ── Department and cost centre on the demo buyer ────────────────────────────
  --
  -- Without these, a policy scoped by department would match nothing. Harmless
  -- for the unscoped rules above, but the demo data should reflect a real
  -- organization so the scoping UI has something to filter on.

  UPDATE "User"
     SET "department" = COALESCE("department", 'IT'),
         "costCenter" = COALESCE("costCenter", 'CC-1000')
   WHERE "email" = 'requester@demo.com';

  UPDATE "User"
     SET "department" = COALESCE("department", 'Procurement'),
         "costCenter" = COALESCE("costCenter", 'CC-2000')
   WHERE "email" = 'procurement@demo.com';

  UPDATE "User"
     SET "department" = COALESCE("department", 'Finance'),
         "costCenter" = COALESCE("costCenter", 'CC-3000')
   WHERE "email" = 'finance@demo.com';

  RAISE NOTICE 'Seeded purchase approval policy and rules for tenant %', v_tenant_id;
END $$;

-- ── A request already waiting for a decision ──────────────────────────────────
--
-- An empty inbox teaches nothing about the workflow. This attaches one
-- authorization request to an existing demo offer so there is something to
-- approve on first login.
--
-- It is inserted against a real DealOffer because the table has a restrictive
-- FK on offerId: a fabricated id would violate referential integrity.

-- DealOffer carries neither requestId, vendorId, quoteId nor taxRate: those live
-- on the parent DealRoom (requestId, vendorId, dealId) and the tax column on the
-- offer is named `gst`. Joining DealRoom is therefore mandatory, not stylistic.

-- The applied rule is *derived* from the amount rather than asserted. A seeded
-- chain that disagrees with what the resolver would return is worse than no seed
-- at all: it shows an approver a hierarchy the workflow would never produce.
-- Expression below mirrors the service's threshold calculation exactly.
--
-- Levels are read back out of the chosen rule, so the chain always matches the
-- rule that applies.

INSERT INTO "PurchaseApprovalRequest" (
  "id", "reference", "tenantId", "requestId", "vendorId", "dealRoomId", "dealId",
  "offerId", "quoteId", "submittedById", "status",
  "currency", "unitPrice", "quantity", "taxRate", "taxAmount",
  "freightAmount", "installationAmount", "otherCharges",
  "subtotal", "totalAmount", "thresholdAmount",
  "paymentTerms", "deliveryTimelineDays", "warrantyMonths",
  "policyId", "policyVersion", "appliedRuleId",
  "policySnapshot", "ruleSnapshot", "requesterComment",
  "currentLevel", "revision", "dueAt", "createdAt", "updatedAt"
)
WITH candidate AS (
  SELECT
    o."id"                                   AS offer_id,
    dr."id"                                  AS deal_room_id,
    dr."tenantId"                            AS tenant_id,
    dr."requestId"                           AS request_id,
    dr."vendorId"                            AS vendor_id,
    dr."dealId"                              AS deal_id,
    o."unitPrice"                            AS unit_price,
    o."quantity"                             AS quantity,
    o."gst"                                  AS gst,
    o."freightAmount"                        AS freight,
    o."installationAmount"                   AS installation,
    o."otherCharges"                         AS other_charges,
    o."paymentTerms"                         AS payment_terms,
    o."deliveryTimelineDays"                 AS delivery_days,
    o."warrantyMonths"                       AS warranty_months,
    (o."unitPrice" * o."quantity")           AS subtotal,
    (o."unitPrice" * o."quantity"
       + (o."unitPrice" * o."quantity" * o."gst" / 100)
       + o."freightAmount" + o."installationAmount" + o."otherCharges") AS threshold_amount
  FROM "DealOffer" o
  JOIN "DealRoom" dr ON dr."id" = o."dealRoomId"
  WHERE dr."tenantId" = (SELECT "id" FROM "Tenant" WHERE "slug" = 'demo-corp')
    AND dr."buyerId" = (SELECT "id" FROM "User" WHERE "email" = 'requester@demo.com')
    AND NOT EXISTS (
          SELECT 1 FROM "PurchaseApprovalRequest" r WHERE r."offerId" = o."id"
        )
),
resolved AS (
  SELECT
    c.*,
    p."id"     AS policy_id,
    p."version" AS policy_version,
    p."currency" AS policy_currency,
    p."autoApproveBelowAmount" AS allowance,
    -- Highest priority active rule whose [min, max) band contains the amount,
    -- with the allowance checked first exactly as the resolver does.
    (
      SELECT r."id"
      FROM "PurchaseApprovalRule" r
      WHERE r."policyId" = p."id"
        AND r."isActive"
        AND (r."minAmount" IS NULL OR c.threshold_amount >= r."minAmount")
        AND (r."maxAmount" IS NULL OR c.threshold_amount <  r."maxAmount")
      ORDER BY r."priority" ASC
      LIMIT 1
    ) AS rule_id
  FROM candidate c
  JOIN "PurchaseApprovalPolicy" p ON p."tenantId" = c.tenant_id
)
SELECT
  'pa_req_seed_demo',
  'PA-DEMO-0001',
  res."tenant_id",
  res."request_id",
  res."vendor_id",
  res."deal_room_id",
  res."deal_id",
  res."offer_id",
  NULL,
  (SELECT "id" FROM "User" WHERE "email" = 'requester@demo.com'),
  CASE
    WHEN res."allowance" IS NOT NULL AND res."threshold_amount" < res."allowance"
      THEN 'APPROVED'::"PurchaseApprovalStatus"
    ELSE 'PENDING_APPROVAL'::"PurchaseApprovalStatus"
  END,
  res."policy_currency",
  res."unit_price",
  res."quantity",
  res."gst",
  (res."unit_price" * res."quantity" * res."gst" / 100),
  res."freight",
  res."installation",
  res."other_charges",
  res."subtotal",
  res."threshold_amount",
  res."threshold_amount",
  res."payment_terms",
  res."delivery_days",
  res."warranty_months",
  res."policy_id",
  res."policy_version",
  res."rule_id",
  jsonb_build_object('policyId', res."policy_id", 'version', res."policy_version",
                     'currency', res."policy_currency", 'autoApproveBelowAmount', res."allowance"),
  (SELECT jsonb_build_object('id', r."id", 'name', r."name", 'levels', r."levels")
     FROM "PurchaseApprovalRule" r WHERE r."id" = res."rule_id"),
  'Bearing assortment for the Q3 maintenance run. Needs a decision before we commit funds.',
  1,
  1,
  CURRENT_TIMESTAMP + INTERVAL '2 days',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM resolved res
WHERE res."rule_id" IS NOT NULL;

-- One decision row per level of whichever rule actually applied, all PENDING.
-- currentLevel stays 1 so level 1 is actionable while the rest remain visibly
-- outstanding. jsonb_array_elements does the expansion, so a one-level band
-- seeds one row and a two-level band seeds two without a code change.

INSERT INTO "PurchaseApprovalDecision" (
  "id", "tenantId", "purchaseApprovalRequestId", "level", "requiredRole", "label",
  "status", "createdAt", "updatedAt"
)
SELECT
  'pa_dec_seed_' || a."id" || '_l' || (lvl.ord::int),
  a."tenantId",
  a."id",
  lvl.ord::int,
  (lvl.raw->>'requiredRole')::"UserRole",
  lvl.raw->>'label',
  'PENDING'::"PurchaseApprovalDecisionStatus",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "PurchaseApprovalRequest" a
CROSS JOIN LATERAL jsonb_array_elements(
  (SELECT r."levels" FROM "PurchaseApprovalRule" r WHERE r."id" = a."appliedRuleId")
) WITH ORDINALITY AS lvl(raw, ord)
WHERE a."id" = 'pa_req_seed_demo'
ON CONFLICT ("purchaseApprovalRequestId", "level") DO NOTHING;

COMMIT;

-- ── Verify ────────────────────────────────────────────────────────────────────

SELECT
  p."name"            AS policy,
  p."version"         AS version,
  p."currency"        AS currency,
  p."autoApproveBelowAmount" AS small_purchase_allowance,
  r."name"            AS rule,
  r."minAmount"       AS from_amount,
  r."maxAmount"       AS to_amount,
  jsonb_array_length(r."levels") AS levels
FROM "PurchaseApprovalPolicy" p
JOIN "PurchaseApprovalRule" r ON r."policyId" = p."id"
WHERE p."tenantId" = (SELECT "id" FROM "Tenant" WHERE "slug" = 'demo-corp')
ORDER BY r."priority";

SELECT
  a."reference",
  a."status",
  a."totalAmount",
  a."currentLevel",
  count(d."id") FILTER (WHERE d."status" = 'PENDING') AS pending_levels
FROM "PurchaseApprovalRequest" a
LEFT JOIN "PurchaseApprovalDecision" d ON d."purchaseApprovalRequestId" = a."id"
WHERE a."tenantId" = (SELECT "id" FROM "Tenant" WHERE "slug" = 'demo-corp')
GROUP BY a."id";