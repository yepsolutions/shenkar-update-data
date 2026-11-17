/**
 * Parses an approval subitem + parent into a typed ChangeRequest from the TECHNICAL columns only
 * (text_mm94m751 = technical field id, text_mm94nbav = schemaVersion-1 JSON). The Hebrew display
 * columns are never read; missing/invalid technical data fails safely.
 */
import { z } from "zod";
import { text, type MItem } from "../domain";
import { ManualOnlyError, ValidationError } from "../errors";
import {
  DELETE_MARKER,
  GROUPED_MARKER,
  LABELS,
  NEW_RECORD_MARKER,
  OPT_OUT_MARKER,
  PARENT_BOARD_ID,
  PARENT_COLS,
  SUBITEM_BOARD_ID,
  SUB_COLS,
  boardByLabel,
  type BoardSpec,
} from "../mapping/boards";

export const CHANGE_ID_RE = /^CHG-(REQ-[A-Z0-9]+)-(\d{3,})$/;
const MAX_JSON_CHARS = 20_000;

export type ChangeRequest = {
  changeId: string;
  subitemId: string;
  parentId: string;
  extReqId: string;
  /** National ID exactly as stored on the parent (string; leading zeros preserved). */
  nationalId: string;
  alumniName: string;
  board: BoardSpec;
  targetRecordId?: string;
} & (
  | { op: "update"; kind: "single"; field: string; newValue: string }
  | { op: "update"; kind: "grouped"; fields: Record<string, string> }
  | { op: "create"; fields: Record<string, string> }
  | { op: "delete" }
  | { op: "special"; kind: "interest_opt_out" }
);

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fieldsSchema = z.record(z.string().min(1).max(64), scalar);
const idLike = z.union([z.string(), z.number()]).transform(String);

const v1 = z.object({ schemaVersion: z.literal(1) });
const singleSchema = v1
  .extend({ operation: z.literal("update"), fieldColumnId: z.string().min(1).max(64), existingValue: scalar.optional(), newValue: scalar, targetRecordId: idLike.optional() })
  .passthrough();
const createSchema = v1.extend({ operation: z.literal("create"), fields: fieldsSchema }).passthrough();
const groupedSchema = v1
  .extend({
    operation: z.enum(["update", "grouped_update"]).optional(),
    fields: fieldsSchema,
    existingFields: fieldsSchema.optional(),
    targetRecordId: idLike.optional(),
  })
  .passthrough();
const deleteSchema = v1.extend({ operation: z.literal("delete"), targetRecordId: idLike.optional() }).passthrough();
const specialSchema = v1
  .extend({ operation: z.literal("special"), specialOperation: z.literal("interest_opt_out") })
  .passthrough();

const toStr = (v: string | number | boolean | null): string => (v === null ? "" : String(v));
const stringify = (r: Record<string, string | number | boolean | null>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toStr(v)]));

const COLUMN_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const TARGET_ID_RE = /^\d{1,20}$/;

function parseJson(raw: string): unknown {
  if (raw.length > MAX_JSON_CHARS) throw new ValidationError("INVALID_PAYLOAD_JSON");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError("INVALID_PAYLOAD_JSON");
  }
}

function parseWith<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError("INVALID_PAYLOAD");
  return r.data;
}

export function parseChange(sub: MItem, parent: MItem): ChangeRequest {
  if (sub.boardId !== SUBITEM_BOARD_ID) throw new ValidationError("WRONG_SUBITEM_BOARD");
  if (parent.boardId !== PARENT_BOARD_ID) throw new ValidationError("WRONG_PARENT_BOARD");
  if (sub.parentId !== parent.id) throw new ValidationError("PARENT_MISMATCH");

  const changeId = text(sub, SUB_COLS.changeId);
  const m = CHANGE_ID_RE.exec(changeId);
  if (!m) throw new ValidationError("INVALID_CHANGE_ID");
  const extReqId = text(parent, PARENT_COLS.extReqId);
  if (!extReqId || m[1] !== extReqId) throw new ValidationError("CHANGE_PARENT_ID_MISMATCH");

  const targetLabel = text(sub, SUB_COLS.targetBoard);
  if (targetLabel === LABELS.unmatchedTarget || text(parent, PARENT_COLS.reqType) !== LABELS.reqExisting) {
    throw new ManualOnlyError("UNMATCHED_GRADUATE");
  }
  const board = boardByLabel(targetLabel);
  if (!board) throw new ValidationError("UNKNOWN_TARGET_BOARD");

  // Exact string; never trimmed internally, never coerced to a number.
  const nationalId = text(parent, PARENT_COLS.nationalId);
  if (!nationalId) throw new ValidationError("PARENT_NATIONAL_ID_MISSING");

  // ---- technical columns (authoritative); no fallback to display columns ----
  const tech = text(sub, SUB_COLS.techField);
  const rawJson = (sub.columns[SUB_COLS.changeJson]?.text ?? "").trim();
  if (!tech || !rawJson) throw new ValidationError("TECHNICAL_DATA_MISSING");
  const data = parseJson(rawJson);

  const opLabel = text(sub, SUB_COLS.operation);
  const colTarget = text(sub, SUB_COLS.targetRecordId) || undefined;
  if (colTarget !== undefined && !TARGET_ID_RE.test(colTarget)) throw new ValidationError("INVALID_TARGET_ID");

  const base = {
    changeId,
    subitemId: sub.id,
    parentId: parent.id,
    extReqId,
    nationalId,
    alumniName: text(parent, PARENT_COLS.alumniName),
  };
  const requireLabel = (expected: string) => {
    if (opLabel !== expected) throw new ValidationError("OPERATION_MISMATCH");
  };
  /** Target id from the JSON and/or the target-record column; both must agree when both exist. */
  const resolveTarget = (jsonId: string | undefined, required: boolean): string | undefined => {
    if (jsonId !== undefined && !TARGET_ID_RE.test(jsonId)) throw new ValidationError("INVALID_TARGET_ID");
    if (jsonId !== undefined && colTarget !== undefined && jsonId !== colTarget) throw new ValidationError("TARGET_ID_MISMATCH");
    const id = jsonId ?? colTarget;
    if (!id && required) throw new ValidationError("TARGET_ID_MISSING");
    return id;
  };

  if (tech === NEW_RECORD_MARKER) {
    const p = parseWith(createSchema, data);
    requireLabel(LABELS.opCreate);
    if (!board.canCreate) throw new ValidationError("CREATE_NOT_ALLOWED");
    // A create never uses text_mm90g839 as input: the backend itself writes the created record id there, so on
    // a re-run (e.g. the record was deleted and is created again) it holds a stale id. It is ignored here.
    return { ...base, board, op: "create", fields: stringify(p.fields) };
  }

  if (tech === GROUPED_MARKER) {
    const p = parseWith(groupedSchema, data);
    requireLabel(LABELS.opUpdate);
    if (!board.canUpdate) throw new ValidationError("UPDATE_NOT_ALLOWED");
    const targetRecordId = resolveTarget(p.targetRecordId, true);
    // existingFields is historical information only (last executed approval wins); it is never a precondition.
    return { ...base, board, targetRecordId, op: "update", kind: "grouped", fields: stringify(p.fields) };
  }

  if (tech === DELETE_MARKER) {
    const p = parseWith(deleteSchema, data);
    requireLabel(LABELS.opDelete);
    // Archive safety, re-checked later against the live record: only archivable boards, explicit target id.
    if (!board.canArchive) throw new ValidationError("ARCHIVE_NOT_ALLOWED");
    const targetRecordId = resolveTarget(p.targetRecordId, true);
    return { ...base, board, targetRecordId, op: "delete" };
  }

  if (tech === OPT_OUT_MARKER) {
    parseWith(specialSchema, data);
    requireLabel(LABELS.opUpdate);
    if (board.key !== "community") throw new ValidationError("OPT_OUT_WRONG_BOARD");
    if (!board.canUpdate) throw new ValidationError("UPDATE_NOT_ALLOWED");
    // Targets are always derived from the verified graduate; an id in the request is never used.
    return { ...base, board, op: "special", kind: "interest_opt_out" };
  }

  if (/^__.*__$/.test(tech) || !COLUMN_ID_RE.test(tech)) throw new ValidationError("INVALID_TECHNICAL_ID");

  // Single-field update: the technical id is the actual monday column id.
  const p = parseWith(singleSchema, data);
  requireLabel(LABELS.opUpdate);
  if (p.fieldColumnId !== tech) throw new ValidationError("FIELD_ID_MISMATCH");
  if (!board.canUpdate) throw new ValidationError("UPDATE_NOT_ALLOWED");
  const targetRecordId = resolveTarget(p.targetRecordId, true);
  return {
    ...base,
    board,
    targetRecordId,
    op: "update",
    kind: "single",
    field: tech,
    // existingValue is historical information only; it is never a precondition.
    newValue: toStr(p.newValue),
  };
}
