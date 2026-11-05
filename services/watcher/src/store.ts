import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type * as Sqlite from "node:sqlite";
import type { Alert, CoreState } from "@leaked/watcher-core";

/** What the watcher checkpoints: cursor, recent block hashes (reorg detection), core state, alert history. */
export interface Checkpoint {
  v: 1;
  chainId: number;
  /** Last fully processed block (decimal string), or null before the first poll. */
  lastBlock: string | null;
  /** Most recent processed blocks, ascending: (number, hash). */
  recent: { n: string; hash: string }[];
  core: CoreState | null;
  /** Delivery sequence + recent alerts for `Last-Event-ID` replay. */
  hub: { seq: number; history: { seq: number; type: "alert" | "retract"; alert: Alert }[] };
}

export interface CheckpointStore {
  load(): Checkpoint | null;
  save(c: Checkpoint): void;
  close(): void;
}

/** JSON file, written atomically (temp file + rename). */
export class FileStore implements CheckpointStore {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  load(): Checkpoint | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Checkpoint;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  save(c: Checkpoint): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, this.path);
  }

  close(): void {}
}

/** SQLite via the built-in `node:sqlite` (no native dependency); one row, replaced in a transaction. */
export class SqliteStore implements CheckpointStore {
  private readonly db: Sqlite.DatabaseSync;

  constructor(path: string, sqlite: typeof Sqlite) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new sqlite.DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)");
  }

  load(): Checkpoint | null {
    const row = this.db.prepare("SELECT body FROM checkpoint WHERE id = 1").get() as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Checkpoint) : null;
  }

  save(c: Checkpoint): void {
    this.db.prepare("INSERT OR REPLACE INTO checkpoint (id, body) VALUES (1, ?)").run(JSON.stringify(c));
  }

  close(): void {
    this.db.close();
  }
}

export async function openStore(spec: { type: "file" | "sqlite"; path: string }): Promise<CheckpointStore> {
  if (spec.type === "file") return new FileStore(spec.path);
  return new SqliteStore(spec.path, await import("node:sqlite"));
}
