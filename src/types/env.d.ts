export {};

declare global {
  interface Env {
    APP_ENV: 'local' | 'preview' | 'production';
    AUTH_API_URL: string;
    INTERNAL_API_SECRET?: string;
  }
}
