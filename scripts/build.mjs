// Build step for Vercel (and local testing).
// 1. Copies the Supabase browser library into public/vendor (no runtime CDN dependency).
// 2. Writes public/config.js from environment variables.
//
// Required env (set in Vercel → Project → Settings → Environment Variables,
// or added automatically by the Vercel ↔ Supabase integration):
//   SUPABASE_URL            e.g. https://abcdefgh.supabase.co
//   SUPABASE_ANON_KEY       the project's anon / publishable key (safe to expose; access is enforced by the database)
// Optional:
//   ALLOWED_EMAIL_DOMAINS   comma-separated, default "polynesia.com" (must match the database function)
import { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");

// Local convenience: read .env if present (Vercel injects env vars itself).
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const pick = (...names) => names.map((n) => process.env[n]).find(Boolean) || "";
const url = pick("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const key = pick("SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const domains = (process.env.ALLOWED_EMAIL_DOMAINS || "polynesia.com").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);

if (!url || !key) {
  console.error("\n✖ Missing SUPABASE_URL and/or SUPABASE_ANON_KEY. Add them in Vercel → Settings → Environment Variables (see README).\n");
  process.exit(1);
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)$/i.test(url.replace(/\/$/, "")) && !process.env.ALLOW_CUSTOM_SUPABASE_URL) {
  console.error(`\n✖ SUPABASE_URL doesn't look like a Supabase project URL: ${url}\n  (Set ALLOW_CUSTOM_SUPABASE_URL=1 if you use a custom domain.)\n`);
  process.exit(1);
}

const require = createRequire(import.meta.url);
const umd = join(dirname(require.resolve("@supabase/supabase-js/package.json")), "dist/umd/supabase.js");
mkdirSync(join(pub, "vendor"), { recursive: true });
copyFileSync(umd, join(pub, "vendor/supabase.js"));

const config = { supabaseUrl: url.replace(/\/$/, ""), supabaseAnonKey: key, allowedDomains: domains };
writeFileSync(join(pub, "config.js"), `// Generated at build time by scripts/build.mjs. Do not edit.\nwindow.PCC_CONFIG = ${JSON.stringify(config, null, 2)};\n`);

console.log(`✔ Built for ${config.supabaseUrl} (domains: ${domains.join(", ")})`);
