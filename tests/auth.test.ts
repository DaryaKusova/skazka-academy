import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { User, WorkspaceState } from "../lib/model";

const auth = await import(new URL("../lib/auth.ts", import.meta.url).href) as typeof import("../lib/auth");
const { emptyState, mergeImport, resolveRole } = await import(new URL("../lib/model.ts", import.meta.url).href) as typeof import("../lib/model");
const administrator: User = { id: "native-owner", email: "owner@example.test", name: "Администратор" };
const testPassword = "Fictional-Test-Passphrase-Only-2026";
const request = (ip = "192.0.2.1", cookie = "") => new Request("https://academy.example.test/api/auth/login", { method: "POST", headers: { "cf-connecting-ip": ip, cookie } });

function database() {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(name, migrationDir), "utf8"));
  type Statement = { sql: string; params: (string | number | null)[]; bind: (...values: (string | number | null)[]) => Statement; first: () => Promise<unknown>; all: () => Promise<unknown>; run: () => Promise<unknown>; execute: () => { results: unknown[]; meta: { changes: number } } };
  const db = {
    prepare(sql: string): Statement {
      const statement: Statement = {
        sql, params: [],
        bind(...values) { return { ...statement, params: values }; },
        async first() { return sqlite.prepare(this.sql).get(...this.params) ?? null; },
        async all() { return this.execute(); },
        async run() { return this.execute(); },
        execute() {
          if (/^\s*SELECT/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) {
            const results = sqlite.prepare(this.sql).all(...this.params);
            const changes = (sqlite.prepare("SELECT changes() AS n").get() as { n: number }).n;
            return { results, meta: { changes } };
          }
          const result = sqlite.prepare(this.sql).run(...this.params);
          return { results: [], meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  const initial = mergeImport({ ...emptyState(), ownerId: administrator.id }, { people: [{ id: "p1", name: "Тестовый участник" }, { id: "p2", name: "Другой участник" }], events: [], skills: [] });
  sqlite.prepare("INSERT INTO workspaces (id, revision, document) VALUES ('main', 0, ?)").run(JSON.stringify(initial));
  const stored = () => {
    const row = sqlite.prepare("SELECT revision, document FROM workspaces WHERE id = 'main'").get() as { revision: number; document: string };
    return { revision: row.revision, state: JSON.parse(row.document) as WorkspaceState };
  };
  return { db, sqlite, stored };
}

test("PBKDF2 uses unique salts, validates passwords and compares hashes without plaintext storage", async () => {
  const first = await auth.hashPassword(testPassword), second = await auth.hashPassword(testPassword);
  assert.equal(first.iterations, 100000);
  assert.equal(first.salt.length, 64);
  assert.equal(first.passwordHash.length, 64);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.passwordHash, second.passwordHash);
  assert.equal(await auth.verifyPassword(testPassword, first), true);
  assert.equal(await auth.verifyPassword("wrong-password", first), false);
  assert.equal(auth.normalizeLogin("  Darya.Test  "), "darya.test");
  assert.throws(() => auth.normalizeLogin("русский-логин"), auth.AuthError);
  assert.throws(() => auth.validatePassword("short"), auth.AuthError);
  assert.throws(() => auth.validatePassword("x".repeat(257)), auth.AuthError);
});

test("admin setup changes owner atomically and cannot run twice", async () => {
  const h = database();
  const result = await auth.setCredential(h.db, h.stored(), { login: "admin.test", password: testPassword }, administrator, { initialSetup: true });
  assert.match(result.principalId, /^local:/);
  assert.equal(h.stored().state.ownerId, result.principalId);
  assert.equal(resolveRole(h.stored().state, { ...administrator, id: result.principalId }), "admin");
  assert.equal(JSON.stringify(h.stored()).includes(testPassword), false);
  await assert.rejects(() => auth.setCredential(h.db, h.stored(), { login: "second-admin", password: testPassword }, administrator, { initialSetup: true }), (error: unknown) => error instanceof auth.AuthError && error.status === 409);
  assert.equal((await auth.listAccounts(h.db)).length, 1);
  h.sqlite.close();
});

test("manager login needs no email, persists only token hash, expires and logs out", async () => {
  const h = database();
  await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.one", password: testPassword }, administrator);
  const cookie = await auth.loginWithPassword(h.db, { login: "MANAGER.ONE", password: testPassword }, request());
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Secure/); assert.match(cookie, /Max-Age=604800/);
  const token = cookie.split(";")[0].split("=")[1];
  const rows = h.sqlite.prepare("SELECT token_hash, expires_at FROM auth_sessions").all() as { token_hash: string; expires_at: number }[];
  assert.equal(rows.length, 1); assert.notEqual(rows[0].token_hash, token);
  assert.equal(rows[0].token_hash, await auth.digest(token));
  const user = await auth.getPasswordUser(h.db, new Headers({ cookie }));
  assert.equal(user?.name, "Тестовый участник"); assert.equal(user?.email, "");
  assert.equal(resolveRole(h.stored().state, user!), "manager");
  assert.equal(await auth.getPasswordUser(h.db, new Headers({ cookie }), rows[0].expires_at + 1), null);
  const removed = await auth.revokeSession(h.db, request("192.0.2.1", cookie));
  assert.match(removed, /Max-Age=0/);
  assert.equal(await auth.getPasswordUser(h.db, new Headers({ cookie })), null);
  h.sqlite.close();
});

test("unknown login and wrong password have identical error; rate limit persists in DB", async () => {
  const h = database();
  await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.one", password: testPassword }, administrator);
  let unknown = "", incorrect = "";
  try { await auth.loginWithPassword(h.db, { login: "unknown.user", password: "wrong" }, request("192.0.2.2")); } catch (error) { unknown = (error as Error).message; }
  try { await auth.loginWithPassword(h.db, { login: "manager.one", password: "wrong" }, request()); } catch (error) { incorrect = (error as Error).message; }
  assert.equal(unknown, incorrect);
  for (let attempt = 1; attempt < 8; attempt++) await assert.rejects(() => auth.loginWithPassword(h.db, { login: "manager.one", password: "wrong" }, request()), (error: unknown) => error instanceof auth.AuthError && error.status === 401);
  await assert.rejects(() => auth.loginWithPassword(h.db, { login: "manager.one", password: testPassword }, request()), (error: unknown) => error instanceof auth.AuthError && error.status === 429);
  const rows = h.sqlite.prepare("SELECT key, attempts FROM auth_login_attempts").all() as { key: string; attempts: number }[];
  assert.ok(rows.some((row) => row.attempts === 9));
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key)));
  h.sqlite.close();
});

test("password reset revokes old sessions and changes secret without changing stable principal", async () => {
  const h = database();
  const original = await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.one", password: testPassword }, administrator);
  const cookie = await auth.loginWithPassword(h.db, { login: "manager.one", password: testPassword }, request());
  const reset = await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.new", password: testPassword + "-new" }, administrator);
  assert.equal(reset.principalId, original.principalId);
  assert.equal(await auth.getPasswordUser(h.db, new Headers({ cookie })), null);
  await assert.rejects(() => auth.loginWithPassword(h.db, { login: "manager.one", password: testPassword }, request()), auth.AuthError);
  const fresh = await auth.loginWithPassword(h.db, { login: "manager.new", password: testPassword + "-new" }, request());
  assert.ok(await auth.getPasswordUser(h.db, new Headers({ cookie: fresh })));
  h.sqlite.close();
});

test("a login finishing after password reset cannot mint a session from the old hash", async () => {
  const h = database();
  const original = await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.one", password: testPassword }, administrator);
  const old = h.sqlite.prepare("SELECT password_hash FROM auth_credentials WHERE principal_id = ?").get(original.principalId) as { password_hash: string };
  await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.one", password: testPassword + "-changed" }, administrator);
  await assert.rejects(() => auth.createSession(h.db, original.principalId, request(), old.password_hash), (error: unknown) => error instanceof auth.AuthError && error.status === 401);
  assert.equal(h.sqlite.prepare("SELECT token_hash FROM auth_sessions").all().length, 0);
  h.sqlite.close();
});

test("competing admin resets cannot issue a late session for the superseded password", async () => {
  const h = database();
  await auth.setCredential(h.db, h.stored(), { login: "admin.test", password: testPassword }, administrator, { initialSetup: true });
  // Request A commits its reset, then pauses before session creation. Request B commits
  // a newer reset and revokes all old sessions before request A is allowed to resume.
  const first = await auth.setCredential(h.db, h.stored(), { login: "admin.test", password: testPassword + "-A" }, administrator, { recovery: true });
  const second = await auth.setCredential(h.db, h.stored(), { login: "admin.test", password: testPassword + "-B" }, administrator, { recovery: true });
  assert.equal(first.principalId, second.principalId);
  assert.notEqual(first.passwordHash, second.passwordHash);
  await assert.rejects(() => auth.createSession(h.db, first.principalId, request(), first.passwordHash), (error: unknown) => error instanceof auth.AuthError && error.status === 401);
  const cookie = await auth.createSession(h.db, second.principalId, request(), second.passwordHash);
  const user = await auth.getPasswordUser(h.db, new Headers({ cookie }));
  assert.equal(user?.id, second.principalId);
  assert.equal(h.sqlite.prepare("SELECT token_hash FROM auth_sessions").all().length, 1);
  assert.equal(JSON.stringify(h.stored()).includes(first.passwordHash), false);
  assert.equal(JSON.stringify(h.stored()).includes(second.passwordHash), false);
  h.sqlite.close();
});

test("duplicate login rolls back membership and stale revision never creates partial credential", async () => {
  const h = database();
  const old = h.stored();
  await auth.setCredential(h.db, old, { personId: "p1", login: "manager.one", password: testPassword }, administrator);
  const before = h.stored();
  await assert.rejects(() => auth.setCredential(h.db, before, { personId: "p2", login: "manager.one", password: testPassword }, administrator), (error: unknown) => error instanceof auth.AuthError && error.status === 409);
  assert.deepEqual(h.stored(), before);
  await assert.rejects(() => auth.setCredential(h.db, old, { personId: "p2", login: "manager.two", password: testPassword }, administrator), (error: unknown) => error instanceof auth.AuthError && error.status === 409);
  assert.deepEqual(h.stored(), before);
  assert.equal((await auth.listAccounts(h.db)).length, 1);
  h.sqlite.close();
});

test("inactive participant cannot log in and existing session has pending membership", async () => {
  const h = database();
  await auth.setCredential(h.db, h.stored(), { personId: "p1", login: "manager.one", password: testPassword }, administrator);
  const cookie = await auth.loginWithPassword(h.db, { login: "manager.one", password: testPassword }, request());
  const stored = h.stored(); stored.state.people[0].active = false;
  h.sqlite.prepare("UPDATE workspaces SET document = ? WHERE id = 'main'").run(JSON.stringify(stored.state));
  const user = await auth.getPasswordUser(h.db, new Headers({ cookie }));
  assert.equal(resolveRole(h.stored().state, user!), "pending");
  await assert.rejects(() => auth.loginWithPassword(h.db, { login: "manager.one", password: testPassword }, request()), (error: unknown) => error instanceof auth.AuthError && error.status === 401);
  h.sqlite.close();
});

test("admin transfer validates hash fields and is one-time", async () => {
  const h = database(), transfer = { login: "admin.test", principalId: `local:${crypto.randomUUID()}`, ...await auth.hashPassword(testPassword) };
  assert.throws(() => auth.validateTransferCredential({ ...transfer, iterations: 1 }), auth.AuthError);
  assert.throws(() => auth.validateTransferCredential({ ...transfer, passwordHash: "plaintext" }), auth.AuthError);
  await auth.transferAdminCredential(h.db, h.stored(), transfer);
  assert.equal(h.stored().state.ownerId, transfer.principalId);
  await assert.rejects(() => auth.transferAdminCredential(h.db, h.stored(), transfer), (error: unknown) => error instanceof auth.AuthError && error.status === 409);
  assert.ok(await auth.loginWithPassword(h.db, { login: "admin.test", password: testPassword }, request()));
  h.sqlite.close();
});

test("production setup never opens on localhost and production cookies are Secure", () => {
  assert.equal(auth.isLocalSetupRequest(new Request("https://academy.example.test/")), false);
  assert.equal(auth.isLocalSetupRequest(new Request("http://localhost:3000/")), false);
  assert.match(auth.sessionCookie(auth.randomToken(), new Request("http://localhost:3000/")), /Secure/);
});
