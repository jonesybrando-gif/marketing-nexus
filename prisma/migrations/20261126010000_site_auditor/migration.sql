-- AlterTable
ALTER TABLE "Agency" ADD COLUMN     "siteAuditMonthlyCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 25;

-- CreateTable
CREATE TABLE "SiteAuditConfig" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'weekly',
    "dayOfWeek" INTEGER DEFAULT 1,
    "dayOfMonth" INTEGER,
    "maxPages" INTEGER NOT NULL DEFAULT 500,
    "enableJs" BOOLEAN NOT NULL DEFAULT false,
    "lighthouse" TEXT NOT NULL DEFAULT 'homepage',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteAuditConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAudit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "targetUrl" TEXT NOT NULL,
    "maxPages" INTEGER NOT NULL,
    "enableJs" BOOLEAN NOT NULL DEFAULT false,
    "lighthouseMode" TEXT NOT NULL DEFAULT 'off',
    "providerTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "pagesCrawled" INTEGER,
    "healthScore" INTEGER,
    "onpageScore" DOUBLE PRECISION,
    "errorPages" INTEGER,
    "warningPages" INTEGER,
    "noticePages" INTEGER,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actualCost" DOUBLE PRECISION,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "lighthouse" JSONB,
    "aiSummary" JSONB,
    "aiSummaryError" TEXT,
    "detailPrunedAt" TIMESTAMP(3),

    CONSTRAINT "SiteAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAuditIssue" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "sampleUrls" JSONB,

    CONSTRAINT "SiteAuditIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAuditPage" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER,
    "issueKeys" TEXT[],
    "onpageScore" DOUBLE PRECISION,

    CONSTRAINT "SiteAuditPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteAuditConfig_clientId_key" ON "SiteAuditConfig"("clientId");

-- CreateIndex
CREATE INDEX "SiteAudit_clientId_createdAt_idx" ON "SiteAudit"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteAudit_status_idx" ON "SiteAudit"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SiteAuditIssue_auditId_issueKey_key" ON "SiteAuditIssue"("auditId", "issueKey");

-- CreateIndex
CREATE INDEX "SiteAuditPage_auditId_idx" ON "SiteAuditPage"("auditId");

-- AddForeignKey
ALTER TABLE "SiteAuditConfig" ADD CONSTRAINT "SiteAuditConfig_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAudit" ADD CONSTRAINT "SiteAudit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAuditIssue" ADD CONSTRAINT "SiteAuditIssue_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SiteAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteAuditPage" ADD CONSTRAINT "SiteAuditPage_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SiteAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

