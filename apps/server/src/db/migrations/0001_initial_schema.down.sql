-- 0001_initial_schema.down.sql
-- Reverts the Nyx initial schema. Drop order is the reverse of creation so
-- foreign-key dependencies unwind cleanly. Indexes and triggers drop with
-- their tables. The migration runner wraps this file in a single transaction.

DROP TABLE deploy_registry;
DROP TABLE reconcile_runs;
DROP TABLE orphan_deposits;
DROP TABLE deposit_refs;
DROP TABLE chat_messages;
DROP TABLE turns;
DROP TABLE ledger_entries;
DROP FUNCTION ledger_entries_forbid_mutation();
DROP TABLE project_file_versions;
DROP TABLE project_files;
DROP TABLE projects;
DROP TABLE proving_tokens;
DROP TABLE auth_nonces;
DROP TABLE sessions;
DROP TABLE accounts;
