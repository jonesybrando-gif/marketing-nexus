-- AlterTable
ALTER TABLE "SiteAudit" ADD COLUMN     "analysisVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "ignorePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "serverSoftware" TEXT,
ADD COLUMN     "stopRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SiteAuditConfig" ADD COLUMN     "ignorePatterns" TEXT[] DEFAULT ARRAY[]::TEXT[];

