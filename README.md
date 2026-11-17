# Shenkar Alumni — Approval Backend

Standalone Node.js/TypeScript/Express service. When a reviewer sets an approval subitem (board `5107603016`,
column `color_mm90s5mz`) to `מאושר`, it applies that change to the target alumni board in monday.com.
Independent of the Alumni Portal and its SQLite database. Spec: `approval-subitem-contract.md` (portal repo, `reference/`).

## How it works

```
monday ──webhook──▶ POST /handle-approval ──▶ durable job queue (SQLite) ──▶ worker ──▶ executor ──▶ monday GraphQL
        (challenge echoed first)   200 immediately        │                              │
                                                          └── per-change state machine (CHG-… idempotency key, lease, intent, reconcile)
```

* `src/webhook` – challenge handshake (first), auth (`?token=` or monday JWT), filtering, durable enqueue.
* `src/monday` – GraphQL client (reads retried; **mutations never blindly retried**) and `SchemaGuard` (verifies declared column types / labels against the live board; fails closed with `SCHEMA_DRIFT`).
* `src/mapping` – **central** board / column / type mapping (`boards.ts`) and value conversion per column type (`convert.ts`).
* `src/validation` – parses subitem + parent into a typed change from the **technical columns only** (see below).
* `src/execution` – `plan.ts` (safety checks, reconcile), `executor.ts` (state machine), `parentStatus.ts`, `worker.ts`.
* `src/store` – SQLite (WAL, `synchronous=FULL`) for change records, leases and the job queue.

### Safety rules (enforced in `plan.ts`/`executor.ts`)
1. Subitem re-fetched and re-checked as approved (also right before the mutation).
2. Target exists on the expected board and is active.
3. Graduate: exactly one Alumni item with `national_id` equal to the parent's `alumni_id` (exact string); the target's owner column (`alumni_id`, `referrer_id`, `national_id`) must equal it exactly (leading zeros preserved, never numeric).
4. Column must be in the board's writable allow-list (identity/system columns excluded), its live type must match, labels must exist (no label auto-creation).
5. **Last executed approval wins.** `existingValue` / `existingFields` are historical information, never preconditions: a changed current value does not reject an approved change. Instead, changes touching the same graduate on the same board run strictly one at a time (durable per-target lock in SQLite; a busy change is deferred and retried, not failed).
6. Ambiguity (duplicate graduate, missing owner, wrong board…) ⇒ stop.
* Delete = `archive_item` only, on Education/Career/Community; **never** the Alumni board, never Referrals. Unmatched-graduate requests are left for manual review with no writes.

### Idempotency / crash handling
Key = `CHG-REQ-…-NNN`. Per change: `processing(validating → mutating → mutated) → applied | failed | manual_review`.
The plan (ids + hashes of values, no plaintext) is persisted **before** the mutation. After a crash or an ambiguous
response the executor **reconciles from monday's state** (update: value equals before/after; archive: item state;
create: new item for that graduate not in the pre-mutation baseline whose fields match) and only re-mutates when the
mutation is verifiably absent. Anything unverifiable ⇒ `manual_review` (never auto-retried). A lease (default 120 s) prevents concurrent processing; expired leases are recovered by the worker.

## Structured change data (technical columns)

Approval subitems carry two authoritative technical columns written by the portal. The Hebrew display columns
(`text_mm90znvp`, `text_mm901sz0`, `text_mm909hnw`) are for reviewers only and are **never read** by this backend;
missing/invalid technical data fails safely (`TECHNICAL_DATA_MISSING`, `INVALID_PAYLOAD`, …) with no fallback.

| Column | Meaning |
|---|---|
| `text_mm94m751` | technical field id |
| `text_mm94nbav` | `schemaVersion: 1` JSON |

| Technical id | JSON | Effect |
|---|---|---|
| a monday column id, e.g. `job_title` | `operation:"update"`, `fieldColumnId` (= technical id), `newValue` (`existingValue` optional, historical) | single-field update, target = `text_mm90g839` |
| `__new_record__` | `operation:"create"`, `fields{columnId:value}` | create (owner column set from the verified parent) |
| `__grouped_update__` | `fields` (`existingFields` optional, historical) | every field validated first, then ONE mutation |
| `__delete_record__` | `operation:"delete"`, `targetRecordId` | **archive** only (Education/Career/Community), strict ownership + board checks |
| `__interest_opt_out__` | `operation:"special"`, `specialOperation:"interest_opt_out"` | see below |

The `סוג פעולה` label must agree with the JSON operation (`עדכון`/`הוספה`/`מחיקה`); for `__interest_opt_out__` it must be exactly `עדכון`; a target id present in both JSON and
`text_mm90g839` must be identical. Explicit, column-specific alias maps in `src/mapping/boards.ts` (exact match only; null, empty and other values are rejected; no generic boolean→status conversion): `mailing_consent` (Alumni) and `ongoing` (Education): `true`/`"true"` → `כן`, `false`/`"false"` → `לא`.

### Community interest opt-out
On approval: identify the graduate from the verified parent → re-fetch the graduate's records on board `5107221003` →
keep only records whose `alumni_id` equals the national ID **exactly** → set `interest_status` = `לא מעוניין` on those not already
there. Other graduates' records, look-alikes and ownerless records are never modified; ids in the request are ignored; nothing is
ever archived or deleted. If there is nothing to change (no records, or all already opted out) no source-board write is made and the
change is still marked `בוצע`. Each record is re-verified right before its write. The operation is idempotent and resumable: the
target list is persisted before the first write; after a partial failure or crash the retry only writes records still pending.
The same last-executed-wins rule applies (records are re-fetched at execution time). Ordinary `interest_status` updates from the portal remain regular single-field updates.

## Sync / parent status
Subitem `color_mm90k1tq`: `בתהליך` → `בוצע` / `נכשל`.

Parent application status `color_mm9085gm` combines each subitem's decision (`color_mm90s5mz`) and sync status (`color_mm90k1tq`), read from monday.
**A rejected subitem is marked `בוצע`** (nothing is executed for it) by the parent recalculation, which also backfills older rejected
subitems; only rejected subitems' sync column is ever written this way. Then:

* no subitems → `טרם הוחל` (default)
* at least one subitem not yet approved or rejected → `בתהליך` (even if its sync column still says `בוצע`)
* **every** subitem, rejected ones included, is `בוצע` → `הושלם`
* otherwise: no approved subitem has started yet (all `טרם בוצע`) → `טרם הוחל`; any approved one running, failed or partly done → `בתהליך`

If a rejected subitem is approved again, its stale `בוצע` is reset to `בתהליך` as soon as its change is claimed, so the parent cannot look
completed before the change really ran. A change rejected while it is being processed is not marked `נכשל`.

It is recalculated after every execution and whenever a
reviewer sets a decision to `נדחה` or `ממתין לאישור` (the webhook enqueues a parent-refresh job), because rejecting the last pending
subitem completes the request. Only labels that exist on the live parent column are written, nothing is created (older names
`מתבצע`/`בוצע` are used if the column still has those). The parent is written only when its label actually changes, and only that one
column: the approval decisions and the reviewer's `req_status` are never touched. Parent-label problems never block applying a change.
Concurrency: refreshes are serialized per parent by a durable leased lock + dirty flag; the holder recalculates from fresh monday state
until no newer request arrived, so a stale calculation can never be the last write. A failed parent update never affects the subitem
result: the parent stays dirty and the worker's periodic sweep retries it. Under `DRY_RUN=true` nothing is written.

## Environment
See `.env.example`. Required: `MONDAY_API_TOKEN`. `WEBHOOK_TOKEN` is optional (if set, the webhook URL must end with `?token=<value>`; if unset the endpoint is open, which is safe because events only enqueue a subitem id and everything is re-verified in monday). **`DRY_RUN` defaults to `true`** (reads + validation only, zero monday writes); set `DRY_RUN=false` explicitly to go live.

## Local development
```bash
npm install
npm test            # unit + integration tests against an in-memory fake monday
npm run build
cp .env.example .env   # fill in MONDAY_API_TOKEN
npm run dev            # starts the backend AND the monday tunnel (prints the public URL); loads .env automatically
npm run dev:server     # backend only
curl -s -XPOST localhost:3000/handle-approval -H 'content-type: application/json' -d '{"challenge":"abc"}'
```
`npm run dev` also runs `mapps tunnel:create -p 3000` (monday apps CLI), which prints the public URL monday uses to reach your machine (port 3000; edit `dev:tunnel` in package.json if you change `PORT`).

## Webhook setup
Per monday's docs, subitem column changes need the **`change_subitem_column_value`** event, created on the **parent board** (`5107220927`); `change_status_column_value` / `change_specific_column_value` do not cover subitem columns. The payload for this event is not documented, so the handler accepts `pulseId`/`itemId`, `columnId`, `value.label.text`, optional `parentItemId`, and re-verifies everything by re-fetching.
```graphql
mutation {
  create_webhook(
    board_id: 5107220927
    url: "https://YOUR_HOST/handle-approval"
    event: change_subitem_column_value
  ) { id board_id }
}
```
(URL max 255 chars.) Failed deliveries are retried by monday once a minute for 30 minutes — handled idempotently. Optionally create the webhook with an integration-app token and set `MONDAY_SIGNING_SECRET` to also verify the JWT.
**Do this only after dry-run validation (below).**

## Go-live checklist
1. Run with `DRY_RUN=true`, approve a test subitem, check logs for `dry_run_plan` and `GET /admin/changes/:id` (state `dry_run`).
2. Resolve the gaps in the report (contract vs. live data) first.
3. Set `DRY_RUN=false`, test on a sandbox request.

## Operator endpoints (need `ADMIN_TOKEN`)
`GET /admin/changes/:changeId`; `POST /admin/changes/:changeId/resolve {"outcome":"applied"|"not_applied"}` after verifying monday by hand for a `manual_review` change.

## Logging
JSON lines; only ids, states and error codes. Keys that can carry personal data/secrets are redacted by an allow-by-default **deny-list** in `logger.ts`.
