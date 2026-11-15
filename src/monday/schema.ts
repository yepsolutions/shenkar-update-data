import type { ColumnDef, MondayApi } from "../domain";
import { ValidationError } from "../errors";
import { BOARDS, REQUIRED_CONTROL_LABELS, SUBITEM_BOARD_ID, SUB_COLS, type BoardSpec } from "../mapping/boards";

/**
 * Verifies the backend's declared column mapping against the live board schema and exposes
 * live label definitions. Fails closed (SCHEMA_DRIFT) when a mapped column is missing or its
 * type changed.
 */
export class SchemaGuard {
  private cache = new Map<string, { at: number; cols: Map<string, ColumnDef> }>();

  constructor(
    private readonly api: MondayApi,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async columns(boardId: string): Promise<Map<string, ColumnDef>> {
    const hit = this.cache.get(boardId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.cols;
    const defs = await this.api.getBoardColumns(boardId);
    if (defs.length === 0) throw new ValidationError("SCHEMA_DRIFT", `board ${boardId} schema unavailable`);
    const cols = new Map(defs.map((d) => [d.id, d]));
    this.cache.set(boardId, { at: this.now(), cols });
    return cols;
  }

  /** Returns the live definition of a writable column after checking the declared type matches. */
  async writableColumn(spec: BoardSpec, columnId: string): Promise<ColumnDef> {
    const declared = spec.writable[columnId];
    if (!declared) throw new ValidationError("COLUMN_NOT_WRITABLE");
    const live = (await this.columns(spec.id)).get(columnId);
    if (!live) throw new ValidationError("SCHEMA_DRIFT", `column ${columnId} missing on ${spec.key}`);
    if (live.type !== declared) throw new ValidationError("SCHEMA_DRIFT", `column ${columnId} type changed`);
    return live;
  }

  /** The owner column must exist as a text column on the target board. */
  async assertOwnerColumn(spec: BoardSpec): Promise<void> {
    const live = (await this.columns(spec.id)).get(spec.ownerColumn);
    if (!live || live.type !== "text") throw new ValidationError("SCHEMA_DRIFT", "owner column");
  }

  /** Control labels (sync / application statuses) must exist before we try to set them. */
  async assertControlLabels(): Promise<void> {
    for (const req of REQUIRED_CONTROL_LABELS) {
      const col = (await this.columns(req.boardId)).get(req.column);
      const have = new Set((col?.labels ?? []).map((l) => l.label));
      for (const l of req.labels) {
        if (!have.has(l)) throw new ValidationError("SCHEMA_DRIFT", `label missing on ${req.column}`);
      }
    }
  }

  /** The technical columns the parser relies on must exist as text columns on the subitem board. */
  async assertTechnicalColumns(): Promise<void> {
    const cols = await this.columns(SUBITEM_BOARD_ID);
    for (const id of [SUB_COLS.techField, SUB_COLS.changeJson]) {
      if (cols.get(id)?.type !== "text") throw new ValidationError("SCHEMA_DRIFT", `technical column ${id}`);
    }
  }

  allSpecs() {
    return Object.values(BOARDS);
  }
}
