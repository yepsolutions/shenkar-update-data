export interface ItemColumn {
  type: string;
  text: string | null;
  /** Parsed JSON value (monday returns it as a JSON string). */
  value: any;
}

export interface MItem {
  id: string;
  name: string;
  state: string; // active | archived | deleted
  createdAt?: string;
  boardId: string;
  parentId?: string;
  columns: Record<string, ItemColumn>;
}

export interface LabelDef {
  id: number;
  label: string;
}

export interface ColumnDef {
  id: string;
  type: string;
  labels?: LabelDef[];
}

/** Everything the backend needs from monday. Implemented by MondayClient and by the test fake. */
export interface MondayApi {
  getItem(id: string): Promise<MItem | null>;
  getBoardColumns(boardId: string): Promise<ColumnDef[]>;
  /** Items (active) whose text column equals value; caller must re-check equality locally. */
  findItemsByColumn(boardId: string, columnId: string, value: string): Promise<MItem[]>;
  listSubitems(parentId: string): Promise<MItem[]>;
  /** Mutations: throw MondayRejectedError (definitely not applied) or MondayUncertainError (unknown). */
  changeColumns(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void>;
  createItem(boardId: string, name: string, values: Record<string, unknown>): Promise<string>;
  archiveItem(itemId: string): Promise<void>;
}

export const text = (item: MItem, col: string): string => (item.columns[col]?.text ?? "").trim();
