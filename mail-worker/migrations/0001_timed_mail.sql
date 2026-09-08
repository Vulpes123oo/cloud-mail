-- Run once against the existing mail database before enabling TIMED_MAIL_ENABLED.
CREATE TABLE timed_address_history(email TEXT PRIMARY KEY COLLATE NOCASE);
INSERT OR IGNORE INTO timed_address_history SELECT email FROM account;
CREATE TRIGGER timed_history_legacy_insert AFTER INSERT ON account BEGIN
 INSERT OR IGNORE INTO timed_address_history VALUES(NEW.email); END;
CREATE TRIGGER timed_history_legacy_update AFTER UPDATE OF email ON account BEGIN
 INSERT OR IGNORE INTO timed_address_history VALUES(NEW.email); END;
CREATE TRIGGER timed_history_no_delete BEFORE DELETE ON timed_address_history BEGIN
 SELECT RAISE(ABORT,'Address history is permanent'); END;
CREATE TRIGGER timed_history_no_update BEFORE UPDATE ON timed_address_history BEGIN
 SELECT RAISE(ABORT,'Address history is immutable'); END;
CREATE TABLE timed_customer (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, salt TEXT NOT NULL,
 expires_at INTEGER NOT NULL DEFAULT 0,
 remaining INTEGER NOT NULL DEFAULT 0 CHECK(remaining BETWEEN 0 AND 20)
);
CREATE TABLE timed_card (
 code_hash TEXT PRIMARY KEY, issued_at INTEGER NOT NULL,
 redeemed_by TEXT REFERENCES timed_customer(id), redeemed_at INTEGER,
 CHECK ((redeemed_by IS NULL) = (redeemed_at IS NULL))
);
CREATE TRIGGER timed_card_once BEFORE UPDATE ON timed_card
 WHEN OLD.redeemed_by IS NOT NULL BEGIN SELECT RAISE(ABORT,'Card already used'); END;
CREATE TRIGGER timed_card_redeem AFTER UPDATE OF redeemed_by ON timed_card
 WHEN OLD.redeemed_by IS NULL AND NEW.redeemed_by IS NOT NULL BEGIN
 UPDATE timed_customer SET expires_at = max(expires_at, NEW.redeemed_at) + 600,
 remaining = 20 WHERE id = NEW.redeemed_by;
END;
CREATE TABLE timed_session (
 token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES timed_customer(id),
 expires_at INTEGER NOT NULL
);
CREATE INDEX timed_session_customer ON timed_session(customer_id);
CREATE TABLE timed_mailbox (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 customer_id TEXT NOT NULL REFERENCES timed_customer(id), created_at INTEGER NOT NULL
);
CREATE INDEX timed_mailbox_customer ON timed_mailbox(customer_id);
CREATE TRIGGER timed_mailbox_quota BEFORE INSERT ON timed_mailbox BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM timed_customer WHERE id=NEW.customer_id
 AND expires_at > NEW.created_at AND remaining > 0) THEN RAISE(ABORT,'Mailbox quota or time exhausted') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM timed_address_history WHERE email=NEW.email COLLATE NOCASE)
 THEN RAISE(ABORT,'Address previously used') END;
END;
CREATE TRIGGER timed_mailbox_consume AFTER INSERT ON timed_mailbox BEGIN
 INSERT INTO timed_address_history VALUES(NEW.email);
 UPDATE timed_customer SET remaining=remaining-1 WHERE id=NEW.customer_id;
END;
CREATE TRIGGER timed_mailbox_no_delete BEFORE DELETE ON timed_mailbox BEGIN
 SELECT RAISE(ABORT,'Address reservations are permanent'); END;
CREATE TRIGGER timed_mailbox_no_reassign BEFORE UPDATE ON timed_mailbox BEGIN
 SELECT RAISE(ABORT,'Address reservations are immutable'); END;
CREATE TRIGGER timed_legacy_address_insert BEFORE INSERT ON account
 WHEN EXISTS(SELECT 1 FROM timed_mailbox WHERE email=NEW.email COLLATE NOCASE)
 BEGIN SELECT RAISE(ABORT,'Address reserved'); END;
CREATE TRIGGER timed_legacy_address_update BEFORE UPDATE OF email ON account
 WHEN EXISTS(SELECT 1 FROM timed_mailbox WHERE email=NEW.email COLLATE NOCASE)
 BEGIN SELECT RAISE(ABORT,'Address reserved'); END;
CREATE TABLE timed_message (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES timed_mailbox(id),
 sender TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 attachments TEXT NOT NULL DEFAULT '[]', received_at INTEGER NOT NULL
);
CREATE INDEX timed_message_mailbox ON timed_message(mailbox_id,received_at DESC);
CREATE TABLE timed_rate (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL);
