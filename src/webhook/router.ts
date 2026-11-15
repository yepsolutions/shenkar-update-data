import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { LABELS, SUBITEM_BOARD_ID, PARENT_BOARD_ID, SUB_COLS } from "../mapping/boards";
import type { Store } from "../store/store";
import { safeEqual, verifyMondayJwt } from "./auth";

const idLike = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform(String);

const eventSchema = z
  .object({
    boardId: idLike.optional(),
    pulseId: idLike.optional(),
    itemId: idLike.optional(),
    parentItemId: idLike.optional(),
    parentItemBoardId: idLike.optional(),
    columnId: z.string().max(64).optional(),
    value: z.any().optional(),
    triggerUuid: z.string().max(100).optional(),
  })
  .passthrough();

/** Pulled from the (loosely documented) payload: value.label.text for status columns. */
const statusLabel = (v: any): string => (typeof v?.label?.text === "string" ? v.label.text : "");

export function webhookRouter(deps: { store: Store; log: Logger; config: Pick<Config, "WEBHOOK_TOKEN" | "MONDAY_SIGNING_SECRET"> }) {
  const { store, log, config } = deps;
  const r = Router();

  r.post("/webhooks/monday", (req: Request, res: Response) => {
    const body = req.body;

    // 1. Challenge handshake comes FIRST, before auth or any other processing.
    if (body && typeof body === "object" && typeof body.challenge === "string") {
      res.status(200).json({ challenge: body.challenge });
      return;
    }

    // 2. Authenticate: shared token in the URL, or a valid monday JWT.
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const tokenOk = token !== "" && safeEqual(token, config.WEBHOOK_TOKEN);
    const jwtOk =
      !!config.MONDAY_SIGNING_SECRET && verifyMondayJwt(req.headers.authorization, config.MONDAY_SIGNING_SECRET);
    if (!tokenOk && !jwtOk) {
      log.warn("webhook_unauthorized");
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    // 3. Validate shape and filter.
    const parsed = z.object({ event: eventSchema }).safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }
    const ev = parsed.data.event;
    const subitemId = ev.pulseId ?? ev.itemId;
    const ignore = (reason: string) => {
      log.info("webhook_ignored", { reason });
      res.status(200).json({ ok: true, ignored: reason });
    };
    if (!subitemId) return ignore("no_item");
    if (ev.columnId !== SUB_COLS.decision) return ignore("other_column");
    if (ev.boardId && ev.boardId !== SUBITEM_BOARD_ID && ev.boardId !== PARENT_BOARD_ID) return ignore("other_board");
    if (statusLabel(ev.value) !== LABELS.approved) return ignore("not_approved");

    // 4. Durable enqueue, then acknowledge. The executor re-fetches and re-verifies everything.
    store.enqueue(subitemId, ev.parentItemId ?? null);
    log.info("webhook_enqueued", { subitemId });
    res.status(200).json({ ok: true });
  });

  return r;
}
