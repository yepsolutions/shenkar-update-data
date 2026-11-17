import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

describe("state file migration", () => {
  it("upgrades a jobs table created before job kinds existed, keeping its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "shenkar-")), "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, subitem_id TEXT NOT NULL, expected_parent_id TEXT,
      run_after INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', locked_until INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX jobs_one_pending ON jobs(subitem_id) WHERE state='pending';
      INSERT INTO jobs(subitem_id,run_after) VALUES('42',0);`);
    old.close();
    const store = new Store(path);
    expect(store.takeJob()).toMatchObject({ subitem_id: "42", kind: "change" });
    store.enqueue("7", null, "change");
    store.enqueue("7", null, "parent"); // allowed by the new (subitem, kind) uniqueness
    store.enqueue("7", null, "parent"); // duplicate collapsed
    expect(store.pendingJobCount()).toBe(3);
    store.close();
    new Store(path).close(); // opening again is a no-op
  });
});
