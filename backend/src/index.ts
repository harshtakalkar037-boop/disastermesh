import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const db = await openDatabase(config);
await migrate(db);
const app = await buildApp({ db, config });
await app.listen({ host: config.host, port: config.port });
console.log(`DisasterMesh API listening on http://${config.host}:${config.port} (db=${db.kind}). Prototype only. Not a certified emergency service.`);
if (!config.tlsCert) console.log("TLS is not enabled. Set TLS_CERT and TLS_KEY, or terminate TLS in a reverse proxy, before exposing this API.");
if (db.kind === "pglite") console.log("Using PGlite because DATABASE_URL is unset. This is a local demo store, not production PostgreSQL.");
