ALTER TABLE "users"     ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);
ALTER TABLE "transfers" ADD CONSTRAINT transfers_amount_positive  CHECK (amount > 0);
ALTER TABLE "transfers" ADD CONSTRAINT transfers_no_self_transfer CHECK ("fromUserId" <> "toUserId");
ALTER TABLE "ledgers"   ADD CONSTRAINT ledgers_amount_nonzero     CHECK ((type = 'CREDIT' AND amount > 0) OR (type = 'DEBIT' AND amount < 0));
