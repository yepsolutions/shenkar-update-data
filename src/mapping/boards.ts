/**
 * Centralized mapping of monday boards, columns and column types.
 * Column types here are the backend's declared contract; they are verified against the live
 * board schema before use (see monday/schema.ts), and a mismatch fails closed.
 */
import type { ColType } from "./convert";

export const PARENT_BOARD_ID = "5107220927";
export const SUBITEM_BOARD_ID = "5107603016";

export const PARENT_COLS = {
  reqType: "req_type",
  nationalId: "alumni_id",
  alumniName: "alumni_name",
  extReqId: "ext_req_id",
  application: "color_mm9085gm",
  reqStatus: "req_status", // reviewer's decision: NEVER written by this backend
} as const;

export const SUB_COLS = {
  decision: "color_mm90s5mz",
  targetBoard: "status",
  operation: "color_mm90ba0r",
  /**
   * Authoritative technical columns. The Hebrew display columns (text_mm90znvp / text_mm901sz0 /
   * text_mm909hnw) are human-readable only and are deliberately NOT referenced anywhere in this backend.
   */
  techField: "text_mm94m751",
  changeJson: "text_mm94nbav",
  changeId: "text_mm90t835",
  sync: "color_mm90k1tq",
  targetRecordId: "text_mm90g839",
} as const;

export const LABELS = {
  approved: "מאושר",
  rejected: "נדחה",
  pendingApproval: "ממתין לאישור",
  syncNotDone: "טרם בוצע",
  syncRunning: "בתהליך",
  syncDone: "בוצע",
  syncFailed: "נכשל",
  /** Parent application status labels (color_mm9085gm) as they exist on the live board. */
  appNotApplied: "טרם הוחל",
  appRunning: "בתהליך",
  appDone: "הושלם",
  opCreate: "הוספה",
  opUpdate: "עדכון",
  opDelete: "מחיקה",
  reqExisting: "עדכון בוגר קיים",
  unmatchedTarget: "בקשת זיהוי",
} as const;

export const NEW_RECORD_MARKER = "__new_record__";
export const GROUPED_MARKER = "__grouped_update__";
export const DELETE_MARKER = "__delete_record__";
export const OPT_OUT_MARKER = "__interest_opt_out__";
export const OPT_OUT_STATUS_LABEL = "לא מעוניין";

export type BoardKey = "alumni" | "education" | "career" | "referrals" | "community";

export interface BoardSpec {
  key: BoardKey;
  id: string;
  /** Label on the subitem `status` column. */
  targetLabel: string;
  /** Text column on the target board that holds the graduate's national ID. */
  ownerColumn: string;
  /** Columns a change may write, with their declared monday types. Identity columns are excluded. */
  writable: Record<string, ColType>;
  canCreate: boolean;
  canUpdate: boolean;
  /** Archive allowed for this board (the main Alumni record can never be archived). */
  canArchive: boolean;
  /** On create: at least one of these must be supplied (when non-empty). */
  requireAnyOf?: string[];
  /**
   * Explicit, column-specific portal-value → label mappings (exact string match, nothing else is mapped:
   * not null, not empty, not other casings). There is deliberately no generic boolean→status conversion.
   */
  labelAliases?: Record<string, Record<string, string>>;
  itemName(fields: Record<string, string>, alumniName: string): string;
}

const YES_NO = { true: "כן", false: "לא" };

const graduateName = (_f: Record<string, string>, n: string) => n || "בוגר";

export const BOARDS: Record<BoardKey, BoardSpec> = {
  alumni: {
    key: "alumni",
    id: "5107220847",
    targetLabel: "בוגרים",
    ownerColumn: "national_id",
    writable: {
      first_name: "text",
      last_name: "text",
      prev_last_name: "text",
      current_last_name: "text",
      gender: "status",
      birth_date: "date",
      mobile: "phone",
      email_main: "email",
      email_extra: "email",
      country: "country",
      city: "text",
      linkedin: "link",
      website: "link",
      wants_contact: "status",
      mailing_consent: "status",
      no_work_declared: "checkbox",
    },
    canCreate: false,
    canUpdate: true,
    canArchive: false, // never archive the main Alumni record
    labelAliases: { mailing_consent: YES_NO },
    itemName: graduateName,
  },
  education: {
    key: "education",
    id: "5107220873",
    targetLabel: "השכלה",
    ownerColumn: "alumni_id",
    writable: {
      other_institution: "text",
      institution: "dropdown",
      degree_type: "status",
      faculty: "dropdown",
      department: "dropdown",
      degree_free: "text",
      end_year: "numbers",
      ongoing: "status",
      expected_end_year: "numbers",
      end_year_hebrew: "text",
    },
    canCreate: true,
    canUpdate: true,
    canArchive: true,
    labelAliases: { ongoing: YES_NO },
    itemName: graduateName,
  },
  career: {
    key: "career",
    id: "5107220887",
    targetLabel: "תעסוקה",
    ownerColumn: "alumni_id",
    writable: {
      company: "text",
      job_title: "text",
      employment_type: "status",
      role_status: "status",
      start_year: "numbers",
      end_year: "numbers",
      work_country: "country",
      work_city: "text",
      cluster: "dropdown",
      domain: "dropdown",
      related_shenkar: "status",
    },
    canCreate: true,
    canUpdate: true,
    canArchive: true,
    requireAnyOf: ["company", "job_title"],
    itemName: graduateName,
  },
  referrals: {
    key: "referrals",
    id: "5107220900",
    targetLabel: "הפניות בוגרים",
    ownerColumn: "referrer_id",
    writable: {
      referrer_name: "text",
      ref_first: "text",
      ref_last: "text",
      ref_phone: "phone",
      ref_email: "email",
      est_grad_year: "numbers",
      est_department: "text",
      ref_source: "dropdown",
    },
    canCreate: true,
    canUpdate: false, // referrals are only ever created after approval
    canArchive: false,
    requireAnyOf: ["ref_first", "ref_last"],
    itemName: (f) => `${f.ref_first ?? ""} ${f.ref_last ?? ""}`.trim() || "הפניה",
  },
  community: {
    key: "community",
    id: "5107221003",
    targetLabel: "תחומי עניין",
    ownerColumn: "alumni_id",
    writable: {
      activity_type: "dropdown",
      interest_status: "status",
      update_date: "date",
      notes: "long_text",
    },
    canCreate: true,
    canUpdate: true,
    canArchive: true,
    requireAnyOf: ["activity_type"],
    itemName: graduateName,
  },
};

export const boardByLabel = (label: string): BoardSpec | undefined =>
  Object.values(BOARDS).find((b) => b.targetLabel === label);

export const boardById = (id: string): BoardSpec | undefined =>
  Object.values(BOARDS).find((b) => b.id === id);

/**
 * Control-column labels that must exist for changes to be applied. The parent application-status column is
 * deliberately NOT here: parent status is best-effort and must never block applying an approved change
 * (see parentStatus.ts, which adapts to the labels that exist on the live parent column).
 */
export const REQUIRED_CONTROL_LABELS: Array<{ boardId: string; column: string; labels: string[] }> = [
  { boardId: SUBITEM_BOARD_ID, column: SUB_COLS.decision, labels: [LABELS.approved] },
  {
    boardId: SUBITEM_BOARD_ID,
    column: SUB_COLS.sync,
    labels: [LABELS.syncRunning, LABELS.syncDone, LABELS.syncFailed],
  },
  { boardId: "5107221003", column: "interest_status", labels: [OPT_OUT_STATUS_LABEL] },
];
