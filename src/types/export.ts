export interface ExportDatabaseData {
  data: Record<string, object[]>;
  schemaHash?: string;
  url?: string;
}

export interface ExportPgDataStructure {
  data: object;
  mode: 'pglite' | 'postgres';
  schemaHash: string;
}
