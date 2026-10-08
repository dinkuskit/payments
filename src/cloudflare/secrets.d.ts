// Supplied through the host secret binding, never plugin settings or source.
interface Env {
  STRIPE_API_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  AUTHORIZE_NET_API_LOGIN_ID: string;
  AUTHORIZE_NET_TRANSACTION_KEY: string;
  AUTHORIZE_NET_SIGNATURE_KEY: string;
}
