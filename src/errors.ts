/** Terminal, clean failure: nothing was mutated. Sync status becomes `נכשל`; may be retried by re-approving. */
export class ValidationError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "ValidationError";
  }
}

/** Outcome cannot be verified safely. Never retried automatically. */
export class ManualReviewError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "ManualReviewError";
  }
}

/** Request must be handled by a human (e.g. unmatched graduate). No monday writes are made. */
export class ManualOnlyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ManualOnlyError";
  }
}

/** monday definitively refused a mutation: it was NOT applied. */
export class MondayRejectedError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "MondayRejectedError";
  }
}

/** A mutation may or may not have been applied (timeout, 5xx, unknown error). Must be reconciled. */
export class MondayUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MondayUncertainError";
  }
}

/** A read failed transiently; safe to retry the whole job later. */
export class MondayTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MondayTransientError";
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("lease lost");
    this.name = "LeaseLostError";
  }
}

/** Another change holds the per-target lock; try again shortly (not a failure, not counted as an attempt). */
export class DeferredError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "DeferredError";
  }
}
