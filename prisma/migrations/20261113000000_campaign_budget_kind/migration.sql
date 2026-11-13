-- Which platform budget a campaign uses, so daily budgets can be added up
-- without counting a shared budget twice, and so lifetime/total budgets are
-- never mistaken for daily ones (Budget Pacing "Adjustment Needed").
ALTER TABLE "Campaign" ADD COLUMN "platformBudgetId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "platformBudgetKind" TEXT;
