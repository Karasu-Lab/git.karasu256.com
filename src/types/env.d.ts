export {};

declare global {
  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    error?: string;
    meta: Record<string, unknown>;
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run(): Promise<D1Result<Record<string, unknown>>>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
  }

  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    ADMIN_DB: D1Database;
    AUTH_API_URL: string;
    INTERNAL_API_SECRET?: string;
    STORAGE_ENDPOINT: string;
    STORAGE_BUCKET: string;
    STORAGE_ACCESS_KEY_ID: string;
    STORAGE_SECRET_ACCESS_KEY: string;
    STORAGE_REGION?: string;
  }
}
