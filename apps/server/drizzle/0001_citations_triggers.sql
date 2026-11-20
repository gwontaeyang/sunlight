-- citations has a polymorphic owner (ownerType, ownerId) and no FK.
-- 1. AFTER DELETE triggers remove the citations of a deleted owner row, including rows removed by
--    ON DELETE CASCADE (verified by test/contract/db.migrate.test.ts).
-- 2. BEFORE INSERT rejects a citation whose owner row does not exist (e.g. a run that finishes after its
--    message was deleted): the writer must check the owner inside its transaction.
-- 3. The owner of an existing citation cannot be changed.
-- startupRecovery.ts also removes orphans as a fallback.
CREATE TRIGGER `citations_owner_messages_ad` AFTER DELETE ON `messages` BEGIN
  DELETE FROM `citations` WHERE `ownerType` = 'message' AND `ownerId` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `citations_owner_paper_card_items_ad` AFTER DELETE ON `paper_card_items` BEGIN
  DELETE FROM `citations` WHERE `ownerType` = 'paper_card_item' AND `ownerId` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `citations_owner_review_cards_ad` AFTER DELETE ON `review_cards` BEGIN
  DELETE FROM `citations` WHERE `ownerType` = 'review_card' AND `ownerId` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `citations_owner_explain_backs_ad` AFTER DELETE ON `explain_backs` BEGIN
  DELETE FROM `citations` WHERE `ownerType` = 'explain_back' AND `ownerId` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `citations_owner_glossary_terms_ad` AFTER DELETE ON `glossary_terms` BEGIN
  DELETE FROM `citations` WHERE `ownerType` = 'glossary_term' AND `ownerId` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `citations_owner_exists_bi` BEFORE INSERT ON `citations` BEGIN
  SELECT RAISE(ABORT, 'citations: owner row does not exist')
  WHERE NOT (
    (NEW.`ownerType` = 'message' AND EXISTS (SELECT 1 FROM `messages` WHERE `id` = NEW.`ownerId`))
    OR (NEW.`ownerType` = 'paper_card_item' AND EXISTS (SELECT 1 FROM `paper_card_items` WHERE `id` = NEW.`ownerId`))
    OR (NEW.`ownerType` = 'review_card' AND EXISTS (SELECT 1 FROM `review_cards` WHERE `id` = NEW.`ownerId`))
    OR (NEW.`ownerType` = 'explain_back' AND EXISTS (SELECT 1 FROM `explain_backs` WHERE `id` = NEW.`ownerId`))
    OR (NEW.`ownerType` = 'glossary_term' AND EXISTS (SELECT 1 FROM `glossary_terms` WHERE `id` = NEW.`ownerId`))
  );
END;
--> statement-breakpoint
CREATE TRIGGER `citations_owner_fixed_bu` BEFORE UPDATE OF `ownerType`, `ownerId` ON `citations` BEGIN
  SELECT RAISE(ABORT, 'citations: the owner of a citation cannot be changed')
  WHERE NEW.`ownerType` IS NOT OLD.`ownerType` OR NEW.`ownerId` IS NOT OLD.`ownerId`;
END;
