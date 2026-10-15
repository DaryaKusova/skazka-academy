import type { User, WorkspaceState } from "./model";

// 100,000 remains compatible with deployed Workers versions that cap PBKDF2 calls.
// Source: https://github.com/cloudflare/workerd/pull/7550 (still open 2026-10-15).
export const PASSWORD_ITERATIONS = 100_000;
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_COOKIE = "academy_session";
const ATTEMPT_WINDOW = 15 * 60 * 1000;
const DEVELOPMENT = process.env.NODE_ENV === "development";
type Stored = { revision: number; state: WorkspaceState };
export type Credential = { principalId: string; login: string; personId: string | null; salt: string; passwordHash: string; iterations: number; createdAt: number; updatedAt: number };
export type TransferCredential = Pick<Credential, "principalId" | "login" | "salt" | "passwordHash" | "iterations">;
const CREDENTIAL_COLUMNS = "principal_id AS principalId, login, person_id AS personId, salt, password_hash AS passwordHash, iterations, created_at AS createdAt, updated_at AS updatedAt";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = "AuthError"; this.status = status; }
}
export function normalizeLogin(value: unknown): string {
  if (typeof value !== "string") throw new AuthError("Укажите логин.");
  const login = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(login)) throw new AuthError("Логин: 3–64 символа, латинские буквы, цифры, точка, дефис или подчёркивание.");
  return login;
}
export function validatePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256) throw new AuthError("Пароль должен содержать от 12 до 256 символов.");
  return value;
}
function hex(value: ArrayBuffer | Uint8Array): string { return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index++) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}
export function randomToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
export async function digest(value: string): Promise<string> { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
export function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let mismatch = 0;
  for (let index = 0; index < 64; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}
export async function hashPassword(password: string, salt = randomToken(), iterations = PASSWORD_ITERATIONS): Promise<{ salt: string; passwordHash: string; iterations: number }> {
  if (!/^[a-f0-9]{64}$/.test(salt) || iterations !== PASSWORD_ITERATIONS) throw new AuthError("Некорректные параметры защиты пароля.");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: fromHex(salt), iterations, hash: "SHA-256" }, key, 256);
  return { salt, passwordHash: hex(bits), iterations };
}
export async function verifyPassword(password: string, credential: Pick<Credential, "salt" | "passwordHash" | "iterations">): Promise<boolean> {
  const actual = await hashPassword(password, credential.salt, credential.iterations);
  return timingSafeEqualHex(actual.passwordHash, credential.passwordHash);
}
export function isLocalSetupRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return DEVELOPMENT && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
export function sessionCookie(token: string, request: Request, clear = false): string {
  const secure = isLocalSetupRequest(request) ? "" : "; Secure";
  return `${SESSION_COOKIE}=${clear ? "" : token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_TTL_SECONDS}${secure}`;
}
function cookieToken(headers: Headers): string | null {
  const match = headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = match?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function getAdminCredential(db: D1Database): Promise<Credential | null> {
  return db.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM auth_credentials WHERE person_id IS NULL LIMIT 1`).first<Credential>();
}
export async function listAccounts(db: D1Database): Promise<{ personId: string | null; login: string }[]> {
  const result = await db.prepare("SELECT person_id AS personId, login FROM auth_credentials ORDER BY login").all<{ personId: string | null; login: string }>();
  return result.results;
}
export async function getPasswordUser(db: D1Database, headers: Headers, now = Date.now()): Promise<User | null> {
  const token = cookieToken(headers);
  if (!token) return null;
  const row = await db.prepare("SELECT c.principal_id AS principalId, c.login, c.person_id AS personId FROM auth_sessions s JOIN auth_credentials c ON c.principal_id = s.principal_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(await digest(token), now).first<{ principalId: string; login: string; personId: string | null }>();
  if (!row) return null;
  const workspace = await db.prepare("SELECT document FROM workspaces WHERE id = 'main'").first<{ document: string }>();
  if (!workspace) return null;
  const state = JSON.parse(workspace.document) as WorkspaceState;
  const person = state.people.find((item) => item.id === row.personId && item.userId === row.principalId);
  return { id: row.principalId, email: person?.email ?? "", name: person?.name ?? (state.ownerId === row.principalId ? "Администратор L&D" : row.login) };
}
export async function createSession(db: D1Database, principalId: string, request: Request, expectedPasswordHash: string): Promise<string> {
  const token = randomToken(), now = Date.now();
  const insert = db.prepare("INSERT INTO auth_sessions (token_hash, principal_id, created_at, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_credentials WHERE principal_id = ? AND password_hash = ?)").bind(await digest(token), principalId, now, now + SESSION_TTL_SECONDS * 1000, principalId, expectedPasswordHash);
  const result = await db.batch([
    db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now),
    insert,
    db.prepare("DELETE FROM auth_sessions WHERE principal_id = ? AND token_hash NOT IN (SELECT token_hash FROM auth_sessions WHERE principal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 10)").bind(principalId, principalId),
  ]);
  // A password reset may race the PBKDF2 verification. Do not mint a session for an
  // obsolete password after its reset already revoked the user's previous sessions.
  if ((result[1].meta.changes ?? 0) !== 1) throw new AuthError("Неверный логин или пароль.", 401);
  return sessionCookie(token, request);
}
export async function revokeSession(db: D1Database, request: Request): Promise<string> {
  const token = cookieToken(request.headers);
  if (token) await db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(await digest(token)).run();
  return sessionCookie("", request, true);
}
async function consumeLoginAttempt(db: D1Database, login: string, request: Request): Promise<string[]> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // Only Cloudflare's connecting IP is used, never user-provided X-Forwarded-For.
  const keys = await Promise.all([`pair:${login}:${ip}`, `login:${login}`, `ip:${ip}`].map(digest));
  const now = Date.now(), cutoff = now - ATTEMPT_WINDOW;
  const statements = keys.map((key) => db.prepare("INSERT INTO auth_login_attempts (key, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN window_start <= ? THEN 1 ELSE attempts + 1 END, window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END RETURNING attempts").bind(key, now, cutoff, cutoff, now));
  const results = await db.batch<{ attempts: number }>(statements);
  await db.prepare("DELETE FROM auth_login_attempts WHERE window_start < ?").bind(now - 24 * 60 * 60 * 1000).run();
  if (results.some((result, index) => (result.results[0]?.attempts ?? 999) > [8, 20, 60][index])) throw new AuthError("Не удалось войти. Попробуйте позже.", 429);
  return keys;
}
export async function loginWithPassword(db: D1Database, input: Record<string, unknown>, request: Request): Promise<string> {
  let login = "invalid-login", validLogin = true;
  try { login = normalizeLogin(input.login); } catch { validLogin = false; }
  const keys = await consumeLoginAttempt(db, login, request);
  const credential = await db.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM auth_credentials WHERE login = ?`).bind(login).first<Credential>();
  const password = typeof input.password === "string" && input.password.length <= 256 ? input.password : "";
  const valid = await verifyPassword(password, credential ?? { salt: "0".repeat(64), passwordHash: "0".repeat(64), iterations: PASSWORD_ITERATIONS });
  const workspace = await db.prepare("SELECT document FROM workspaces WHERE id = 'main'").first<{ document: string }>();
  const state = workspace ? JSON.parse(workspace.document) as WorkspaceState : null;
  const member = credential && state && (credential.personId === null ? state.ownerId === credential.principalId : state.people.some((person) => person.id === credential.personId && person.userId === credential.principalId && person.active));
  if (!validLogin || !valid || !member || !credential) throw new AuthError("Неверный логин или пароль.", 401);
  const cookie = await createSession(db, credential.principalId, request, credential.passwordHash);
  await db.batch(keys.slice(0, 2).map((key) => db.prepare("DELETE FROM auth_login_attempts WHERE key = ?").bind(key)));
  return cookie;
}
export function validateTransferCredential(raw: unknown): TransferCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AuthError("Некорректные данные администратора.");
  const value = raw as Record<string, unknown>, login = normalizeLogin(value.login);
  if (typeof value.principalId !== "string" || !/^local:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.principalId) || typeof value.salt !== "string" || !/^[a-f0-9]{64}$/.test(value.salt) || typeof value.passwordHash !== "string" || !/^[a-f0-9]{64}$/.test(value.passwordHash) || value.iterations !== PASSWORD_ITERATIONS) throw new AuthError("Некорректные параметры учётной записи администратора.");
  return { principalId: value.principalId, login, salt: value.salt, passwordHash: value.passwordHash, iterations: PASSWORD_ITERATIONS };
}
function withCredentialAudit(state: WorkspaceState, actor: User, action: string, entityId: string): WorkspaceState {
  return { ...state, audit: [...state.audit, { id: crypto.randomUUID(), at: new Date().toISOString(), actorId: actor.id, actorName: actor.name.slice(0, 300), action, entityId }].slice(-100) };
}
/** Transactional compare-and-swap: neither password nor membership can update alone. */
export async function commitCredential(db: D1Database, stored: Stored, next: WorkspaceState, credential: Credential): Promise<void> {
  const document = JSON.stringify(next);
  if (new TextEncoder().encode(document).byteLength > 1_900_000) throw new AuthError("Достигнут лимит рабочей области.", 413);
  const guard = "EXISTS (SELECT 1 FROM workspaces WHERE id = 'main' AND revision = ? AND document = ?)";
  let result;
  try {
    result = await db.batch([
      db.prepare("UPDATE workspaces SET document = ?, revision = revision + 1 WHERE id = 'main' AND revision = ?").bind(document, stored.revision),
      db.prepare(`INSERT INTO auth_credentials (principal_id, login, person_id, salt, password_hash, iterations, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard} ON CONFLICT(principal_id) DO UPDATE SET login = excluded.login, salt = excluded.salt, password_hash = excluded.password_hash, iterations = excluded.iterations, updated_at = excluded.updated_at`).bind(credential.principalId, credential.login, credential.personId, credential.salt, credential.passwordHash, credential.iterations, credential.createdAt, credential.updatedAt, stored.revision + 1, document),
      db.prepare(`DELETE FROM auth_sessions WHERE principal_id = ? AND ${guard}`).bind(credential.principalId, stored.revision + 1, document),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) throw new AuthError("Этот логин уже используется.", 409);
    throw error;
  }
  if ((result[0].meta.changes ?? 0) !== 1 || (result[1].meta.changes ?? 0) !== 1) throw new AuthError("Данные уже изменены. Обновите страницу и повторите действие.", 409);
}
export async function setCredential(db: D1Database, stored: Stored, input: Record<string, unknown>, actor: User, options: { initialSetup?: boolean; recovery?: boolean } = {}): Promise<{ principalId: string; self: boolean; passwordHash: string }> {
  const login = normalizeLogin(input.login), password = validatePassword(input.password);
  if (input.personId !== undefined && input.personId !== null && typeof input.personId !== "string") throw new AuthError("Некорректный идентификатор участника.");
  const personId = typeof input.personId === "string" && input.personId.trim() ? input.personId.trim() : null;
  if (personId && (options.initialSetup || options.recovery)) throw new AuthError("Настройка предназначена для администратора.");
  const person = personId ? stored.state.people.find((item) => item.id === personId) : null;
  if (personId && !person) throw new AuthError("Участник не найден.", 404);
  const existing = personId ? await db.prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM auth_credentials WHERE person_id = ?`).bind(personId).first<Credential>() : await getAdminCredential(db);
  if (options.initialSetup && existing) throw new AuthError("Администратор уже настроен.", 409);
  const principalId = existing?.principalId ?? `local:${crypto.randomUUID()}`;
  const next = withCredentialAudit(personId ? { ...stored.state, people: stored.state.people.map((item) => item.id === personId ? { ...item, userId: principalId } : item) } : { ...stored.state, ownerId: principalId }, actor, options.recovery ? "recoverAdminAccess" : "setCredentials", personId ?? "admin");
  const now = Date.now(), credential: Credential = { principalId, login, personId, ...await hashPassword(password), createdAt: existing?.createdAt ?? now, updatedAt: now };
  await commitCredential(db, stored, next, credential);
  // Internal session guard only; routes must never include this hash in JSON responses.
  return { principalId, self: personId === null, passwordHash: credential.passwordHash };
}
export async function transferAdminCredential(db: D1Database, stored: Stored, raw: unknown, state = stored.state): Promise<void> {
  if (await getAdminCredential(db)) throw new AuthError("Учётная запись администратора уже настроена.", 409);
  const imported = validateTransferCredential(raw), now = Date.now();
  const next = withCredentialAudit({ ...state, ownerId: imported.principalId }, { id: "bootstrap-service", email: "", name: "Первичная настройка" }, "bootstrapAdmin", "admin");
  await commitCredential(db, stored, next, { ...imported, personId: null, createdAt: now, updatedAt: now });
}
