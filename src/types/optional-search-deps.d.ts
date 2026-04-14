declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<
    (input: string, options?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>
  >;
}

declare module "vectra" {
  export class LocalIndex {
    constructor(indexPath: string);
    isIndexCreated(): Promise<boolean>;
    createIndex(): Promise<void>;
    beginUpdate(): Promise<void>;
    endUpdate(): Promise<void>;
    cancelUpdate(): void;
    upsertItem(item: {
      id: string;
      vector: number[];
      metadata: Record<string, unknown>;
    }): Promise<void>;
    queryItems(
      vector: number[],
      query: string,
      topK: number,
      filter?: Record<string, unknown>,
    ): Promise<
      Array<{
        score: number;
        item: {
          id: string;
          metadata: Record<string, unknown>;
        };
      }>
    >;
    listItemsByMetadata(
      filter: Record<string, unknown>,
    ): Promise<Array<{ id: string }>>;
    deleteItem(id: string): Promise<void>;
  }
}
