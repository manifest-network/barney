/// <reference types="@rsbuild/core/types" />

interface ImportMetaEnv {
  readonly PUBLIC_REST_URL?: string;
  readonly PUBLIC_RPC_URL?: string;
  readonly PUBLIC_WEB3AUTH_CLIENT_ID?: string;
  readonly PUBLIC_WEB3AUTH_NETWORK?: string;
  readonly PUBLIC_MORPHEUS_URL?: string;
  readonly PUBLIC_MORPHEUS_MODEL?: string;
  readonly PUBLIC_MORPHEUS_API_KEY?: string;
  readonly PUBLIC_PWR_DENOM?: string;
  readonly PUBLIC_GAS_PRICE?: string;
  readonly PUBLIC_CHAIN_ID?: string;
  readonly APP_VERSION: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
