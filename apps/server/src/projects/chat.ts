/**
 * Chat persistence + rehydration for a project (T055, D23).
 *
 * Chat history is stored alongside the file rows and rehydrated on reopen. The
 * WRITE side is an INTERNAL store method — the turn/agent layer (later stories)
 * calls {@link ChatStore.appendChat} as narration and replies stream; US7 exposes
 * only the READ route (`GET /projects/:id/chat`). There is deliberately no
 * chat-write REST endpoint.
 *
 * `seq` is a per-project monotonic counter. Allocation locks the project row so
 * concurrent appends serialize (D40 single-live-session is the primary guard; the
 * lock is the defensive belt-and-braces). All expiry/time values are the DATABASE
 * clock via `now()`, and every value is bound as a parameter.
 */
import { ChatMessageSchema } from "@nyx/protocol";
import type { ChatMessage, ChatRole } from "@nyx/protocol";
import type { ProjectDb } from "./store.js";
import { ProjectNotFoundError } from "./errors.js";

/** An internally-authored chat message to persist (no REST body maps to this). */
export interface ChatWrite {
  readonly role: ChatRole;
  readonly content: string;
  /** The turn that produced this message, when it is turn-scoped (D23). */
  readonly turnId?: string;
}

/** The chat read/append surface, split out so the file store can compose it. */
export interface ChatStore {
  /** Persist a message, allocating the next per-project `seq`. */
  appendChat(projectId: string, message: ChatWrite): Promise<ChatMessage>;
  /** Full history ordered by `seq` for reopen rehydration (D23). */
  getChat(projectId: string): Promise<ChatMessage[]>;
}

/** Columns projected by the chat queries (bigints arrive as strings). */
interface ChatRow {
  readonly seq: string;
  readonly role: string;
  readonly content: string;
  readonly turn_id: string | null;
  readonly created_at_ms: string;
}

/** Re-brand a DB row into the wire {@link ChatMessage} (validates the role enum). */
function mapChat(row: ChatRow): ChatMessage {
  const base = {
    seq: Number(row.seq),
    role: row.role,
    content: row.content,
    createdAt: Number(row.created_at_ms),
  };
  return ChatMessageSchema.parse(row.turn_id === null ? base : { ...base, turnId: row.turn_id });
}

/**
 * Postgres-backed {@link ChatStore}. `seq` allocation happens under a project-row
 * lock so two concurrent appends can never collide on the `(project_id, seq)` PK.
 */
export class PgChatStore implements ChatStore {
  constructor(private readonly db: ProjectDb) {}

  appendChat(projectId: string, message: ChatWrite): Promise<ChatMessage> {
    return this.db.transaction(async (tx) => {
      // Serialize seq allocation for this project (defensive; D40 already gates writes).
      const project = await tx.query(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [
        projectId,
      ]);
      if (project.rows.length === 0) {
        throw new ProjectNotFoundError(projectId);
      }
      const inserted = await tx.query<ChatRow>(
        `INSERT INTO chat_messages (project_id, seq, role, content, turn_id)
         SELECT $1, COALESCE(MAX(seq), 0) + 1, $2, $3, $4
           FROM chat_messages
          WHERE project_id = $1
        RETURNING seq, role, content, turn_id,
                  (extract(epoch from created_at) * 1000)::bigint AS created_at_ms`,
        [projectId, message.role, message.content, message.turnId ?? null],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error(`chat insert returned no row for project ${projectId}`);
      }
      return mapChat(row);
    });
  }

  async getChat(projectId: string): Promise<ChatMessage[]> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT seq, role, content, turn_id,
              (extract(epoch from created_at) * 1000)::bigint AS created_at_ms
         FROM chat_messages
        WHERE project_id = $1
        ORDER BY seq`,
      [projectId],
    );
    return rows.map(mapChat);
  }
}
