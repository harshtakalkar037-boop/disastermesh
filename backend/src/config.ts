export interface AppConfig {
  host: string;
  port: number;
  jwtSecret: string;
  databaseUrl: string;
  allowPglite: boolean;
  corsOrigin: string;
  dataDir: string;
  nodeEnv: string;
  allowDemoReset: boolean;
  dev: boolean;
  tlsCert?: string;
  tlsKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dev = env.DM_DEV === "1";
  const jwt = env.JWT_SECRET ?? "";
  if (jwt.length < 16 && !dev) {
    throw new Error("JWT_SECRET must be at least 16 characters unless DM_DEV=1");
  }
  const databaseUrl = env.DATABASE_URL ?? "";
  const allowPglite = env.DM_ALLOW_PGLITE === "1" || (dev && databaseUrl.length === 0);
  if (!databaseUrl && !allowPglite) {
    throw new Error("Set DATABASE_URL or DM_ALLOW_PGLITE=1. PGlite is a local demo store, not a production database.");
  }
  return {
    host: env.HTTP_HOST || "127.0.0.1",
    port: Number(env.HTTP_PORT || 8787),
    jwtSecret: jwt.length >= 16 ? jwt : "dev-only-secret-not-for-deployment",
    databaseUrl,
    allowPglite,
    corsOrigin: env.CORS_ORIGIN || "http://localhost:5173",
    dataDir: env.DATA_DIR || "./data",
    nodeEnv: env.NODE_ENV || "development",
    allowDemoReset: env.ALLOW_DEMO_RESET === "1",
    dev,
    tlsCert: env.TLS_CERT,
    tlsKey: env.TLS_KEY,
  };
}
