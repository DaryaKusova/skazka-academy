import { DomainError, object, parseDevelopmentPlan } from "./model.ts";
import type { DevelopmentPlan, PlanImportReceipt, WorkspaceState } from "./model";

type ImportPayload = { importId: string; personId: string; expectedName: string; title: string; plan: DevelopmentPlan };
const HASH = /^[a-f0-9]{64}$/;
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new DomainError("В импорте ИПР присутствуют неизвестные поля.");
}
function field(value: unknown, label: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new DomainError(`Некорректное поле «${label}».`);
  return value.trim();
}
function id(value: unknown): string {
  const result = field(value, "идентификатор", 160);
  if (/[\u0000-\u001f]/.test(result) || result.includes("::")) throw new DomainError("Некорректный идентификатор импорта ИПР.");
  return result;
}
/** JSON keys are sorted recursively; arrays keep their source order. No source data is logged. */
export function canonicalPlanImportPayload(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPlanImportPayload).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalPlanImportPayload((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw new DomainError("Импорт ИПР должен содержать только JSON-значения.");
}
export async function planImportDigest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function equalHash(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < 64; index++) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}
/** A short-lived, exact-payload capability. It grants no session or general write access. */
export async function verifyPlanImportAuthorization(configured: string | undefined, authorization: string | null, rawPayload: unknown, now = Date.now()): Promise<string> {
  const denied = () => new DomainError("Разовый импорт ИПР не авторизован или срок разрешения истёк.", 403);
  let config: Record<string, unknown>;
  try { config = object(JSON.parse(configured || "")); } catch { throw denied(); }
  if (typeof config.tokenHash !== "string" || !HASH.test(config.tokenHash) || typeof config.payloadHash !== "string" || !HASH.test(config.payloadHash) || typeof config.expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(config.expiresAt)) throw denied();
  const expiresAt = Date.parse(config.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt - now > 30 * 60 * 1000) throw denied();
  if (!authorization?.startsWith("Bearer ")) throw denied();
  const token = authorization.slice(7);
  if (token.length < 32 || token.length > 256) throw denied();
  const [tokenHash, payloadHash] = await Promise.all([planImportDigest(token), planImportDigest(canonicalPlanImportPayload(rawPayload))]);
  const tokenValid = equalHash(tokenHash, config.tokenHash), payloadValid = equalHash(payloadHash, config.payloadHash);
  if (!tokenValid || !payloadValid) throw denied();
  return payloadHash;
}
export function parsePlanImportPayload(raw: unknown): ImportPayload {
  const value = object(raw);
  exactKeys(value, ["importId", "personId", "expectedName", "title", "plan"]);
  const personId = id(value.personId), rawPlan = object(value.plan);
  exactKeys(rawPlan, ["goal", "successCriteria", "support", "reviewDate", "details"]);
  const plan = parseDevelopmentPlan(rawPlan, personId);
  if (!plan.details?.sourceNote) throw new DomainError("У импортируемого ИПР должен быть указан источник.");
  return { importId: id(value.importId), personId, expectedName: field(value.expectedName, "ФИО"), title: field(value.title, "должность"), plan };
}
export function applyPrivatePlanImport(state: WorkspaceState, raw: unknown, payloadHash: string, now = new Date().toISOString()): { state: WorkspaceState; receipt: PlanImportReceipt; replayed: boolean } {
  if (!HASH.test(payloadHash)) throw new DomainError("Некорректный отпечаток импорта.");
  const payload = parsePlanImportPayload(raw), receipts = state.planImportReceipts ?? [];
  const existingReceipt = receipts.find(receipt => receipt.importId === payload.importId);
  if (existingReceipt) {
    if (!equalHash(existingReceipt.payloadHash, payloadHash)) throw new DomainError("Этот код импорта уже использован для другого содержимого.", 409);
    return { state, receipt: existingReceipt, replayed: true };
  }
  const person = state.people.find(person => person.id === payload.personId);
  if (!person || person.name !== payload.expectedName) throw new DomainError("Участник импорта не совпадает с сохранённой карточкой.", 409);
  if (state.developmentPlans.some(plan => plan.personId === person.id)) throw new DomainError("У участника уже есть ИПР. Разовый импорт не может его заменить.", 409);
  if (receipts.length >= 100 || state.developmentPlans.length >= 500) throw new DomainError("Достигнут лимит разовых импортов ИПР.", 413);
  const receipt: PlanImportReceipt = { importId: payload.importId, payloadHash, appliedAt: now };
  return {
    state: { ...state, people: state.people.map(item => item.id === person.id ? { ...item, title: payload.title } : item), developmentPlans: [...state.developmentPlans, payload.plan], planImportReceipts: [...receipts, receipt] },
    receipt, replayed: false,
  };
}
