import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { claimMembership, DomainError, emptyState, object, scopeWorkspace } from "./model";
import type { User, WorkspaceState } from "./model";
import { AuthError, getAdminCredential, getPasswordUser } from "./auth";

type Stored = { revision: number; state: WorkspaceState };
type Row = { revision: number; document: string };
type Secrets = { ADMIN_EMAILS?: string; BOOTSTRAP_TOKEN?: string };
const WORKSPACE_ID = "main";
const MAX_DOCUMENT_BYTES = 1_900_000; // D1's individual row limit is 2 MB.
const RESPONSE_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: RESPONSE_HEADERS });
}
export function fail(error: unknown): Response {
  if (error instanceof DomainError || error instanceof AuthError) return json({ error: error.message }, error.status);
  // SQL, secret configuration and imported record details are never sent to clients.
  console.error("Workspace operation failed", error instanceof Error ? error.name : "UnknownError");
  return json({ error: "Не удалось сохранить или загрузить данные. Попробуйте ещё раз." }, 500);
}
export function database(): D1Database {
  if (!env.DB) throw new DomainError("База данных пока не подключена.", 503);
  return env.DB;
}
export async function authenticatedUser(): Promise<User> {
  const local = await getPasswordUser(database(), new Headers(await headers()));
  if (local) return local;
  // Once local credentials are configured, logout stays logged out even if Sites still
  // has a native authentication cookie. Native recovery is a separate explicit route.
  if (!await getAdminCredential(database())) {
    const native = await nativeOwner();
    if (native) return native;
  }
  throw new DomainError("Войдите в личный кабинет.", 401);
}
export async function nativeOwner(): Promise<User | null> {
  const identity = await getChatGPTUser();
  const allowed = ((env as unknown as Secrets).ADMIN_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!identity || !allowed.includes(identity.email.toLowerCase())) return null;
  return { id: identity.userId, email: identity.email, name: identity.displayName };
}
export async function loadStored(): Promise<Stored> {
  const db = database();
  let row = await db.prepare("SELECT revision, document FROM workspaces WHERE id = ?").bind(WORKSPACE_ID).first<Row>();
  if (!row) {
    // Tables are migration-owned. Only create the singleton when missing; pending account
    // reads should not generate database write traffic after workspace initialization.
    await db.prepare("INSERT OR IGNORE INTO workspaces (id, revision, document) VALUES (?, 0, ?)").bind(WORKSPACE_ID, JSON.stringify(emptyState())).run();
    row = await db.prepare("SELECT revision, document FROM workspaces WHERE id = ?").bind(WORKSPACE_ID).first<Row>();
  }
  if (!row) throw new DomainError("Рабочая область недоступна.", 503);
  return { revision: row.revision, state: JSON.parse(row.document) as WorkspaceState };
}
export async function compareAndSwap(revision: number, state: WorkspaceState): Promise<boolean> {
  const document = JSON.stringify(state);
  if (new TextEncoder().encode(document).byteLength > MAX_DOCUMENT_BYTES) throw new DomainError("Рабочая область достигла лимита объёма. Сократите длинные описания перед сохранением.", 413);
  const result = await database().prepare("UPDATE workspaces SET document = ?, revision = revision + 1 WHERE id = ? AND revision = ?").bind(document, WORKSPACE_ID, revision).run();
  return (result.meta.changes ?? 0) === 1;
}
export async function loadForUser(user: User): Promise<Stored> {
  // Password memberships are explicit links. Contact email never provisions access.
  if (await getAdminCredential(database())) return loadStored();
  const allowed = ((env as unknown as Secrets).ADMIN_EMAILS ?? "").split(",").filter(Boolean);
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await loadStored();
    const claimed = claimMembership(stored.state, user, allowed);
    if (claimed === stored.state) return stored;
    if (await compareAndSwap(stored.revision, claimed)) return { state: claimed, revision: stored.revision + 1 };
  }
  throw new DomainError("Данные меняются другим пользователем. Обновите страницу.", 409);
}
export function browserWriteGuard(request: Request): void {
  const origin = request.headers.get("origin");
  let valid = false;
  try { valid = Boolean(origin && new URL(origin).origin === new URL(request.url).origin); } catch { /* invalid URL */ }
  if (!valid || request.headers.get("sec-fetch-site") === "cross-site") throw new DomainError("Запрос изменения должен быть отправлен с этой платформы.", 403);
}
export async function readJson(request: Request, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new DomainError("Используйте Content-Type: application/json.", 415);
  const declared = Number(request.headers.get("content-length"));
  if (declared > maxBytes) throw new DomainError("Слишком большой запрос.", 413);
  if (!request.body) throw new DomainError("Тело запроса отсутствует.");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let count = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    count += value.byteLength;
    if (count > maxBytes) { await reader.cancel(); throw new DomainError("Слишком большой запрос.", 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("Некорректный JSON-файл."); }
}
export function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new DomainError("Укажите актуальную версию данных (revision).");
  return value;
}
export async function saveForUser(stored: Stored, expected: number, next: WorkspaceState, user: User): Promise<Response> {
  if (expected !== stored.revision || !await compareAndSwap(expected, next)) {
    const current = await loadStored();
    return json({ error: "Другой пользователь уже изменил данные. Обновите их и повторите действие.", workspace: scopeWorkspace(current.state, current.revision, user) }, 409);
  }
  return json(scopeWorkspace(next, expected + 1, user));
}
export async function requireBootstrapToken(request: Request): Promise<void> {
  const configured = (env as unknown as Secrets).BOOTSTRAP_TOKEN;
  if (!configured || configured.length < 32) throw new DomainError("Первичный импорт отключён.", 403);
  const supplied = request.headers.get("authorization");
  if (!supplied?.startsWith("Bearer ") || supplied.length > 1024) throw new DomainError("Первичный импорт не авторизован.", 403);
  const encode = new TextEncoder();
  const [left, right] = await Promise.all([configured, supplied.slice(7)].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encode.encode(value)))));
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  if (difference !== 0) throw new DomainError("Первичный импорт не авторизован.", 403);
  // Browser calls still receive the origin guard; unattended service calls have no Origin.
  if (request.headers.has("origin")) browserWriteGuard(request);
}
