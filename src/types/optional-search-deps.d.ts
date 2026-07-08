declare module "@huggingface/transformers" {
  export const env: {
    cacheDir?: string;
  };

  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<
    (input: string, options?: Record<string, unknown>) => Promise<{ tolist(): number[][] }>
  >;
}

declare module "vectra" {
  export class LocalFileStorage {
    constructor(rootFolder?: string);
    createFile(filePath: string, content: Buffer | string): Promise<void>;
    createFolder(folderPath: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    deleteFolder(folderPath: string): Promise<void>;
    getDetails(fileOrFolderPath: string): Promise<unknown>;
    listFiles(folderPath: string, filter?: unknown): Promise<unknown[]>;
    pathExists(fileOrFolderPath: string): Promise<boolean>;
    readFile(filePath: string): Promise<Buffer>;
    upsertFile(filePath: string, content: Buffer | string): Promise<void>;
  }

  export class LocalIndex {
    constructor(indexPath: string, indexName?: string, storage?: LocalFileStorage);
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
