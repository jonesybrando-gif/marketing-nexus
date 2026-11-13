-- The client's Report tab is a dashboard with role 'REPORT' (one per client;
-- NULL roles are ordinary custom dashboards and templates, any number of them).
ALTER TABLE "Dashboard" ADD COLUMN "role" TEXT;
ALTER TABLE "Dashboard" ADD COLUMN "templateKey" TEXT;
ALTER TABLE "Dashboard" ADD COLUMN "layoutVersion" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "Dashboard_clientId_role_key" ON "Dashboard"("clientId", "role");
