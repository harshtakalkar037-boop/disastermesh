import { loadConfig } from "./config.js";
import { migrate, openDatabase } from "./db.js";
import { insertUser } from "./app.js";

const config = loadConfig();
const db = await openDatabase(config);
await migrate(db);

const useDev = process.env.SEED_USE_DEV_DEFAULTS === "1";
const users = [
  ["SEED_ADMIN_EMAIL", "SEED_ADMIN_PASSWORD", "admin", "Admin"],
  ["SEED_OPERATOR_EMAIL", "SEED_OPERATOR_PASSWORD", "operator", "Operator"],
  ["SEED_RESPONDER_EMAIL", "SEED_RESPONDER_PASSWORD", "responder", "Responder"],
  ["SEED_PUBLISHER_EMAIL", "SEED_PUBLISHER_PASSWORD", "alert_publisher", "Alert publisher"],
] as const;

if (useDev) {
  const defaults = [
    ["admin@example.invalid", "dev-admin-pass", "admin", "Dev admin"],
    ["operator@example.invalid", "dev-operator-pass", "operator", "Dev operator"],
    ["responder@example.invalid", "dev-responder-pass", "responder", "Dev responder"],
    ["publisher@example.invalid", "dev-publisher-pass", "alert_publisher", "Dev publisher"],
  ] as const;
  for (const [email, password, role, name] of defaults) {
    const existing = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.length === 0) await insertUser(db, { email, password, role, displayName: name });
  }
  console.log("Seeded LOCAL DEV users at example.invalid. Do not expose these passwords.");
} else {
  for (const [emailKey, passwordKey, role, name] of users) {
    const email = process.env[emailKey];
    const password = process.env[passwordKey];
    if (!email || !password) {
      console.error(`Refusing to seed. Set ${emailKey} and ${passwordKey}, or SEED_USE_DEV_DEFAULTS=1 for a local demo.`);
      process.exit(1);
    }
    if (password.length < 12) {
      console.error(`${passwordKey} must be at least 12 characters.`);
      process.exit(1);
    }
    const existing = await db.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.length === 0) await insertUser(db, { email, password, role, displayName: name });
  }
  console.log("Seeded users from environment.");
}
await db.close();
