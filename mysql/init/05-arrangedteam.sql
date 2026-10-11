-- Ensure rank column exists in pvpgn_arrangedteam for MySQL 8.0 compatibility
ALTER TABLE pvpgn_arrangedteam ADD COLUMN IF NOT EXISTS `rank` int DEFAULT 0;
