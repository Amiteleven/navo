-- First approval checkpoint: audit trail for invalidating
-- an approved requirement after a material change.
--
-- The schema change was applied to Neon via `prisma db push`
-- (the project's workflow, see package.json `db:push`). This
-- file exists for environments where an operator must apply
-- DDL explicitly. It is written to be re-runnable.
--
-- Apply with:  psql "$DATABASE_URL" -f packages/backend/prisma/sql/20261013_requirement_approval_invalidation.sql

-- Recorded by suspendRequirementApprovalsForMaterialChange
-- when an already-approved requirement is edited materially.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REQUIREMENT_APPROVAL_INVALIDATED';
