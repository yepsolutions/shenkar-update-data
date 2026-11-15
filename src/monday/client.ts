import type { ColumnDef, ItemColumn, MItem, MondayApi } from "../domain";
import { MondayRejectedError, MondayTransientError, MondayUncertainError } from "../errors";

/** monday error codes meaning the mutation was refused before any change was made. */
const DEFINITIVE = new Set([
  "ColumnValueException",
  "InvalidColumnIdException",
  "InvalidBoardIdException",
  "InvalidItemIdException",
  "ItemNameTooLongException",
  "ItemsLimitationException",
  "InvalidArgumentException",
  "ResourceNotFoundException",
  "USER_UNAUTHORIZED",
  "missingRequiredPermissions",
  "argumentLiteralsIncompatible",
  "undefinedField",
  "CorrectedValueException",
]);

const ITEM_FRAGMENT = `id name state created_at board { id } parent_item { id } column_values { id type text value }`;

export interface ClientOptions {
  token: string;
  apiVersion: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  readRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class MondayClient implements MondayApi {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ClientOptions) {
    this.endpoint = opts.endpoint ?? "https://api.monday.com/v2";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retries = opts.readRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async post(query: string, variables: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.opts.token,
          "API-Version": this.opts.apiVersion,
        },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON body */
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(t);
    }
  }

  /** Reads are retried; failure after retries is transient (safe to retry the job). */
  private async read<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let last = "unknown";
    for (let i = 0; i <= this.retries; i++) {
      try {
        const { status, body } = await this.post(query, variables);
        if (status === 200 && body && !body.errors) return body.data as T;
        const code = body?.errors?.[0]?.extensions?.code ?? `HTTP_${status}`;
        if (status === 200 && DEFINITIVE.has(code)) throw new MondayRejectedError(code);
        last = String(code);
      } catch (e) {
        if (e instanceof MondayRejectedError) throw e;
        last = (e as Error).name;
      }
      if (i < this.retries) await this.sleep(500 * 2 ** i);
    }
    throw new MondayTransientError(`monday read failed: ${last}`);
  }

  /** Mutations are NEVER blindly retried: an ambiguous failure is surfaced for reconciliation. */
  private async mutate<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: { status: number; body: any };
    try {
      res = await this.post(query, variables);
    } catch (e) {
      throw new MondayUncertainError(`network: ${(e as Error).name}`);
    }
    const { status, body } = res;
    if (status === 200 && body && !body.errors && body.data) return body.data as T;
    const code: string = body?.errors?.[0]?.extensions?.code ?? `HTTP_${status}`;
    if (status === 200 && DEFINITIVE.has(code)) throw new MondayRejectedError(code);
    throw new MondayUncertainError(`mutation outcome unknown: ${code}`);
  }

  private toItem(raw: any, boardId?: string): MItem {
    const columns: Record<string, ItemColumn> = {};
    for (const c of raw.column_values ?? []) {
      let value: any = null;
      if (typeof c.value === "string") {
        try {
          value = JSON.parse(c.value);
        } catch {
          value = null;
        }
      }
      columns[c.id] = { type: c.type, text: c.text ?? null, value };
    }
    return {
      id: String(raw.id),
      name: raw.name ?? "",
      state: raw.state ?? "active",
      createdAt: raw.created_at,
      boardId: String(raw.board?.id ?? boardId ?? ""),
      parentId: raw.parent_item?.id ? String(raw.parent_item.id) : undefined,
      columns,
    };
  }

  async getItem(id: string): Promise<MItem | null> {
    const d = await this.read<{ items: any[] }>(
      `query($ids:[ID!]){ items(ids:$ids){ ${ITEM_FRAGMENT} } }`,
      { ids: [id] },
    );
    const raw = d.items?.[0];
    return raw ? this.toItem(raw) : null;
  }

  async getBoardColumns(boardId: string): Promise<ColumnDef[]> {
    const d = await this.read<{ boards: any[] }>(
      `query($ids:[ID!]){ boards(ids:$ids){ id columns { id type settings_str } } }`,
      { ids: [boardId] },
    );
    const b = d.boards?.[0];
    if (!b) return [];
    return b.columns.map((c: any) => {
      let labels: ColumnDef["labels"];
      if (c.type === "status" || c.type === "dropdown") {
        try {
          const s = JSON.parse(c.settings_str || "{}");
          const deactivated = new Set((s.deactivated_labels ?? []).map(Number));
          const raw = s.labels;
          const list: Array<{ id: number; label: string }> = Array.isArray(raw)
            ? raw.map((l: any) => ({ id: Number(l.id), label: String(l.name ?? l.label) }))
            : Object.entries(raw ?? {}).map(([id, label]) => ({ id: Number(id), label: String(label) }));
          labels = list.filter((l) => !deactivated.has(l.id));
        } catch {
          labels = [];
        }
      }
      return { id: c.id, type: c.type, labels };
    });
  }

  async findItemsByColumn(boardId: string, columnId: string, value: string): Promise<MItem[]> {
    const out: MItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const d: any = await this.read(
        cursor
          ? `query($c:String!){ next_items_page(cursor:$c, limit:100){ cursor items{ ${ITEM_FRAGMENT} } } }`
          : `query($b:ID!,$col:String!,$v:String!){ items_page_by_column_values(board_id:$b, limit:100, columns:[{column_id:$col, column_values:[$v]}]){ cursor items{ ${ITEM_FRAGMENT} } } }`,
        cursor ? { c: cursor } : { b: boardId, col: columnId, v: value },
      );
      const p: any = cursor ? d.next_items_page : d.items_page_by_column_values;
      for (const raw of p.items) out.push(this.toItem(raw, boardId));
      cursor = p.cursor;
      if (!cursor) return out;
    }
    throw new MondayTransientError("too many pages while listing items");
  }

  async listSubitems(parentId: string): Promise<MItem[]> {
    const d = await this.read<{ items: any[] }>(
      `query($ids:[ID!]){ items(ids:$ids){ subitems{ ${ITEM_FRAGMENT} } } }`,
      { ids: [parentId] },
    );
    return (d.items?.[0]?.subitems ?? []).map((r: any) => this.toItem(r));
  }

  async changeColumns(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void> {
    await this.mutate(
      `mutation($b:ID!,$i:ID!,$v:JSON!){ change_multiple_column_values(board_id:$b,item_id:$i,column_values:$v,create_labels_if_missing:false){ id } }`,
      { b: boardId, i: itemId, v: JSON.stringify(values) },
    );
  }

  async createItem(boardId: string, name: string, values: Record<string, unknown>): Promise<string> {
    const d = await this.mutate<{ create_item: { id: string } }>(
      `mutation($b:ID!,$n:String!,$v:JSON!){ create_item(board_id:$b,item_name:$n,column_values:$v,create_labels_if_missing:false){ id } }`,
      { b: boardId, n: name, v: JSON.stringify(values) },
    );
    const id = d.create_item?.id;
    if (!id) throw new MondayUncertainError("create_item returned no id");
    return String(id);
  }

  async archiveItem(itemId: string): Promise<void> {
    await this.mutate(`mutation($i:ID!){ archive_item(item_id:$i){ id } }`, { i: itemId });
  }
}
