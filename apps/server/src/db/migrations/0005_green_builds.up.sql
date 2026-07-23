-- 0005_green_builds.up.sql
-- Latest green build per project (FR-054 greenness gate). One row per project,
-- upserted at every `ready` CompileOutcome; the deploy handler reads it AT DEPLOY
-- TIME (US8 stale-build lesson). No amounts here; plain text provenance columns.
-- The migration runner wraps this file in a single transaction; no BEGIN/COMMIT.

CREATE TABLE project_green_builds (
  project_id       uuid        PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  url_prefix       text        NOT NULL,
  compiler_version text        NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now()
);
