/// <reference types="@rsbuild/core/types" />

interface ImportMetaEnv {
  readonly PUBLIC_REST_URL: string;
  readonly PUBLIC_RPC_URL: string;
  readonly PUBLIC_WEB3AUTH_CLIENT_ID: string;
  readonly PUBLIC_WEB3AUTH_NETWORK: string;
  readonly PUBLIC_OLLAMA_URL: string;
  readonly PUBLIC_OLLAMA_MODEL: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
