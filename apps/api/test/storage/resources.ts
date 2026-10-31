export interface StorageResources {
  databaseUrl: string;
  postgresContainer: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    storageResources: StorageResources;
  }
}
