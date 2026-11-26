-- AlterTable
ALTER TABLE "TrackedKeyword" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "locationName" TEXT;

-- CreateTable
CREATE TABLE "RankLocation" (
    "code" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "countryIso" TEXT NOT NULL,
    "parentCode" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RankLocation_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "RankLocation_countryIso_type_idx" ON "RankLocation"("countryIso", "type");


-- Data: tracked keywords become the unit (keyword x location x device).
-- Keep every existing row and its history. Rows already switched off (an older
-- location or device the project moved away from) are archived; active rows
-- keep their current location and device, so checks continue without a restart.
UPDATE "TrackedKeyword" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "active" = false;

UPDATE "TrackedKeyword" t SET "locationName" = v.name
FROM (VALUES
  (2840, 'United States'),
  (21133, 'Alabama, United States'),
  (21132, 'Alaska, United States'),
  (21136, 'Arizona, United States'),
  (21135, 'Arkansas, United States'),
  (21137, 'California, United States'),
  (21138, 'Colorado, United States'),
  (21139, 'Connecticut, United States'),
  (21141, 'Delaware, United States'),
  (21140, 'District of Columbia, United States'),
  (21142, 'Florida, United States'),
  (21143, 'Georgia, United States'),
  (21144, 'Hawaii, United States'),
  (21146, 'Idaho, United States'),
  (21147, 'Illinois, United States'),
  (21148, 'Indiana, United States'),
  (21145, 'Iowa, United States'),
  (21149, 'Kansas, United States'),
  (21150, 'Kentucky, United States'),
  (21151, 'Louisiana, United States'),
  (21154, 'Maine, United States'),
  (21153, 'Maryland, United States'),
  (21152, 'Massachusetts, United States'),
  (21155, 'Michigan, United States'),
  (21156, 'Minnesota, United States'),
  (21158, 'Mississippi, United States'),
  (21157, 'Missouri, United States'),
  (21159, 'Montana, United States'),
  (21162, 'Nebraska, United States'),
  (21166, 'Nevada, United States'),
  (21163, 'New Hampshire, United States'),
  (21164, 'New Jersey, United States'),
  (21165, 'New Mexico, United States'),
  (21167, 'New York, United States'),
  (21160, 'North Carolina, United States'),
  (21161, 'North Dakota, United States'),
  (21168, 'Ohio, United States'),
  (21169, 'Oklahoma, United States'),
  (21170, 'Oregon, United States'),
  (21171, 'Pennsylvania, United States'),
  (21172, 'Rhode Island, United States'),
  (21173, 'South Carolina, United States'),
  (21174, 'South Dakota, United States'),
  (21175, 'Tennessee, United States'),
  (21176, 'Texas, United States'),
  (21177, 'Utah, United States'),
  (21179, 'Vermont, United States'),
  (21178, 'Virginia, United States'),
  (21180, 'Washington, United States'),
  (21183, 'West Virginia, United States'),
  (21182, 'Wisconsin, United States'),
  (21184, 'Wyoming, United States'),
  (1015254, 'Atlanta, Georgia, United States'),
  (1026201, 'Austin, Texas, United States'),
  (1016367, 'Chicago, Illinois, United States'),
  (1026339, 'Dallas, Texas, United States'),
  (1026481, 'Houston, Texas, United States'),
  (1013962, 'Los Angeles, California, United States'),
  (1015116, 'Miami, Florida, United States'),
  (1023191, 'New York, New York, United States'),
  (1013462, 'Phoenix, Arizona, United States'),
  (1014218, 'San Diego, California, United States'),
  (1014221, 'San Francisco, California, United States'),
  (1027744, 'Seattle, Washington, United States')
) AS v(code, name)
WHERE t."locationCode" = v.code AND t."locationName" IS NULL;
