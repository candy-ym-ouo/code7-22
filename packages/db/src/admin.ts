import "@map/shared/bootstrap";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "pg";
import { hashPassword, normalizeEmail } from "@map/shared/server";
import { dbConfig } from "./config";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function promptHidden(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("A TTY is required to enter the password");
  output.write(question);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      const char = chunk.toString("utf8");
      if (char === "\u0003") {
        input.setRawMode(false);
        input.pause();
        reject(new Error("Cancelled"));
        return;
      }
      if (char === "\r" || char === "\n") {
        input.setRawMode(false);
        input.pause();
        input.off("data", onData);
        output.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    input.on("data", onData);
  });
}

async function main() {
  const rl = createInterface({ input, output });
  const email = argument("--email") ?? await rl.question("Admin email: ");
  const displayName = argument("--name") ?? await rl.question("Display name: ");
  const password = await promptHidden("Password (min 12 chars): ");
  rl.close();

  if (password.length < 12) throw new Error("Password must be at least 12 characters");
  const normalized = normalizeEmail(email);
  const passwordHash = await hashPassword(password);

  const client = new Client({ connectionString: dbConfig.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO users(email, email_normalized, password_hash, display_name, role, status, email_verified_at)
       VALUES ($1, $2, $3, $4, 'admin', 'active', now())
       ON CONFLICT (email_normalized) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         display_name = EXCLUDED.display_name,
         role = 'admin',
         status = 'active',
         email_verified_at = COALESCE(users.email_verified_at, now()),
         updated_at = now()`,
      [email.trim(), normalized, passwordHash, displayName.trim()]
    );
    console.log(`admin ready: ${normalized}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
