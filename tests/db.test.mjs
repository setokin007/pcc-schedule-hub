// Database access-rule tests: runs the migration in an embedded Postgres with stand-ins for Supabase auth.
// Run: npm run test:db
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).length ? process.argv.slice(2) : ["supabase/migrations/20261101000000_schedule_hub.sql", "supabase/seed.sql"];
const [migration, seed] = files.map((p) => readFileSync(p, "utf8"));
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); };

// Minimal stand-ins for what Supabase provides.
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create publication supabase_realtime;
`);
await db.exec(migration);
await db.exec(seed);
await db.exec(seed); // re-run must be harmless

async function as(role, uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${role};`);
  try { return { rows: (await db.query(sql, params)).rows }; }
  catch (e) { return { err: e }; }
  finally { await db.exec("reset role"); }
}
const code = (r) => r.err?.code;

// Domain restriction
for (const bad of ["kai@gmail.com", "kai@polynesia.com.evil.com", "kai@evil.com@polynesia.com", "polynesia.com", null]) {
  let e = null;
  try { await db.query("insert into auth.users (email) values ($1)", [bad]); } catch (x) { e = x; }
  ok(`rejects sign-up for ${bad}`, e?.code === "42501");
}
const ids = {};
for (const [k, email] of [["a", "Admin@Polynesia.com"], ["b", "editor@polynesia.com"], ["c", "viewer@polynesia.com"]]) {
  ids[k] = (await db.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
}
const profs = (await db.query("select email, role from public.profiles order by email")).rows;
ok("profiles created as viewers, emails lower-cased", profs.length === 3 && profs.every((p) => p.role === "viewer") && profs.some((p) => p.email === "admin@polynesia.com"));
let e2 = null;
try { await db.query("update auth.users set email='x@gmail.com' where id=$1", [ids.c]); } catch (x) { e2 = x; }
ok("rejects changing email to another domain", e2?.code === "42501");

// Anonymous: nothing
ok("anon cannot read schedule", code(await as("anon", null, "select * from public.schedule_documents")) === "42501");
ok("anon cannot call save", code(await as("anon", null, "select public.save_document('schedule/main','{}'::jsonb,1)")) === "42501");

// Viewer
let r = await as("authenticated", ids.c, "select version, data->>'mainHoursId' as m from public.schedule_documents");
ok("viewer reads seeded schedule", r.rows?.length === 1 && r.rows[0].version === 1 && r.rows[0].m === "a-gates");
ok("viewer cannot save", code(await as("authenticated", ids.c, "select public.save_document('schedule/main','{\"x\":1}'::jsonb,1)")) === "42501");
ok("viewer cannot write table directly", code(await as("authenticated", ids.c, "update public.schedule_documents set version=99")) === "42501");
ok("viewer cannot promote self", code(await as("authenticated", ids.c, `select public.set_user_role('${ids.c}','admin')`)) === "42501");
ok("viewer cannot edit own role via table", code(await as("authenticated", ids.c, "update public.profiles set role='admin'")) === "42501");
ok("viewer cannot read audit log", (await as("authenticated", ids.c, "select * from public.audit_log")).rows?.length === 0);
r = await as("authenticated", ids.c, "select (public.get_me()).role as role");
ok("get_me returns role", r.rows?.[0]?.role === "viewer");
await as("authenticated", ids.c, "select public.update_my_name('  Kai Viewer ')");
ok("update_my_name trims", (await db.query("select full_name from public.profiles where id=$1", [ids.c])).rows[0].full_name === "Kai Viewer");

// Bootstrap first admin the way the README says (SQL editor = superuser)
await db.query("update public.profiles set role='admin' where email='admin@polynesia.com'");
ok("admin promotes editor", !(await as("authenticated", ids.a, `select public.set_user_role('${ids.b}','editor')`)).err);
ok("last admin cannot demote self", code(await as("authenticated", ids.a, `select public.set_user_role('${ids.a}','viewer')`)) === "22023");

// Editor saves, conflict detection
r = await as("authenticated", ids.b, "select public.save_document('schedule/main', data || '{\"sample\":false}'::jsonb, 1, 'Cleared sample flag') as v from public.schedule_documents");
ok("editor saves v1 -> v2", r.rows?.[0]?.v === 2, r.err?.message || "");
r = await as("authenticated", ids.b, "select public.save_document('schedule/main','{\"stale\":true}'::jsonb, 1, 'stale')");
ok("stale save rejected with 40001", code(r) === "40001");
ok("stale save wrote nothing", (await db.query("select data->>'sample' s, version from public.schedule_documents")).rows[0].s === "false");
ok("editor cannot save unknown path", code(await as("authenticated", ids.b, "select public.save_document('other','{}'::jsonb,0)")) === "22023");
ok("editor cannot save non-object", code(await as("authenticated", ids.b, "select public.save_document('schedule/main','[1]'::jsonb,2)")) === "22023");
ok("editor cannot restore", code(await as("authenticated", ids.b, "select public.restore_version(1)")) === "42501");

// History + restore
r = await as("authenticated", ids.c, "select version, summary, changed_by from public.schedule_history order by id");
ok("history has import + edit", r.rows?.length === 2 && r.rows[1].summary === "Cleared sample flag" && r.rows[1].changed_by === ids.b);
const firstId = (await db.query("select min(id) id from public.schedule_history")).rows[0].id;
r = await as("authenticated", ids.a, `select public.restore_version(${firstId}) as v`);
ok("admin restores v1 as v3", r.rows?.[0]?.v === 3, r.err?.message || "");
ok("restored data is v1 data", (await db.query("select data->>'sample' s from public.schedule_documents")).rows[0].s === "true");
r = await as("authenticated", ids.a, "select action from public.audit_log order by id");
ok("audit log records role change + restore", r.rows?.map((x) => x.action).join(",") === "set_role,restore_version");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
