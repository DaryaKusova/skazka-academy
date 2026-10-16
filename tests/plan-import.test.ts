import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { emptyPlanDetails } from "../lib/development-plan.ts";
import { applyAction, calculateRace, DomainError, emptyState, mergeImport, normalizeState, restoreBootstrapState, scopeWorkspace } from "../lib/model.ts";
import { applyPrivatePlanImport, canonicalPlanImportPayload, parsePlanImportPayload, planImportDigest, verifyPlanImportAuthorization } from "../lib/plan-import.ts";

const now = Date.parse("2026-10-16T09:00:00.000Z"), token = "synthetic-capability-".repeat(3);
const admin = { id: "admin", name: "Администратор", email: "admin@example.test" };
function fixture() {
  let state = mergeImport({ ...emptyState(), ownerId: admin.id }, { people: [{ id: "p1", name: "Учебный участник", title: "Прежняя должность" }, { id: "p2", name: "Другой участник" }], events: [{ id: "e1", title: "Учебная встреча", participantIds: ["p1", "p2"] }], tasks: [{ id: "t1", personId: "p1", title: "Учебная задача" }], skills: [{ id: "s1", name: "Навык" }] });
  state.people[0].userId = "manager";
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", baseline: 1, current: 3, target: 5, evidence: "Учебное наблюдение", date: "2026-10-16" });
  return applyAction(state, admin, "saveDevelopmentPlan", { personId: "p2", goal: "Ручная цель другого участника" });
}
function payload() {
  const details = emptyPlanDetails(); details.sourceNote = "Синтетический учебный образец";
  details.sections.priorities = [{ id: "r1", cells: ["Цель", "Изменение", "Практика", "Критерий", "Связь"] }];
  details.diagnostics = [{ id: "d1", competency: "Навык", selfScore: 8, externalScore: null, employeeComment: "Учебный текст", planResponse: "Практика" }];
  return { importId: "synthetic-import-1", personId: "p1", expectedName: "Учебный участник", title: "Руководитель учебной команды", plan: { goal: "", successCriteria: "", support: "", reviewDate: null, details } };
}
async function configuration(body = payload(), expiry = now + 10 * 60 * 1000) { return JSON.stringify({ tokenHash: await planImportDigest(token), payloadHash: await planImportDigest(canonicalPlanImportPayload(body)), expiresAt: new Date(expiry).toISOString() }); }
function denied(fn: () => unknown, status: number) { assert.throws(fn, (error: unknown) => error instanceof DomainError && error.status === status); }
async function forbidden(operation: Promise<unknown>) { await assert.rejects(operation, (error: unknown) => error instanceof DomainError && error.status === 403); }

test("short-lived capability binds the exact complete payload and accepts canonical key reordering", async () => {
  const body = payload(), config = await configuration(body), hash = await planImportDigest(canonicalPlanImportPayload(body));
  assert.equal(await verifyPlanImportAuthorization(config, `Bearer ${token}`, body, now), hash);
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(await verifyPlanImportAuthorization(config, `Bearer ${token}`, reordered, now), hash);
  await forbidden(verifyPlanImportAuthorization(config, `Bearer ${token}wrong`, body, now));
  await forbidden(verifyPlanImportAuthorization(config, `Bearer ${token}`, { ...body, title: "Подмена" }, now));
  await forbidden(verifyPlanImportAuthorization(config, `Bearer ${token}`, { ...body, unrelatedWrite: true }, now));
  await forbidden(verifyPlanImportAuthorization(undefined, `Bearer ${token}`, body, now));
  await forbidden(verifyPlanImportAuthorization("invalid", `Bearer ${token}`, body, now));
  await forbidden(verifyPlanImportAuthorization(await configuration(body, now), `Bearer ${token}`, body, now));
  await forbidden(verifyPlanImportAuthorization(await configuration(body, now + 31 * 60 * 1000), `Bearer ${token}`, body, now));
});

test("private import changes only target title, new plan and receipt; preserves accounts, all results and XP", async () => {
  const state = fixture(), before = structuredClone(state), body = payload(), hash = await planImportDigest(canonicalPlanImportPayload(body));
  const result = applyPrivatePlanImport(state, body, hash, new Date(now).toISOString());
  assert.deepEqual(state, before, "input state must not mutate");
  assert.equal(result.replayed, false); assert.equal(result.state.people[0].title, body.title);
  assert.deepEqual(result.state.developmentPlans[0], before.developmentPlans[0]);
  assert.equal(result.state.developmentPlans[1].details?.diagnostics[0].externalScore, null);
  const { people, developmentPlans, planImportReceipts, ...untouched } = result.state;
  const { people: oldPeople, developmentPlans: _plans, planImportReceipts: _receipts, ...oldUntouched } = before;
  void _plans; void _receipts;
  assert.deepEqual(untouched, oldUntouched); assert.deepEqual(people, oldPeople.map(person => person.id === "p1" ? { ...person, title: body.title } : person));
  assert.equal(developmentPlans.length, 2); assert.equal(planImportReceipts.length, 1);
  assert.deepEqual(calculateRace(result.state).map(row => row.points), calculateRace(before).map(row => row.points));
  assert.equal("planImportReceipts" in scopeWorkspace(result.state, 2, admin), false);
  assert.equal("planImportReceipts" in scopeWorkspace(result.state, 2, { id: "manager", name: "Учебный участник", email: "" }), false);
  assert.deepEqual(restoreBootstrapState(result.state).planImportReceipts, result.state.planImportReceipts);
});

test("receipt makes retries idempotent even after manual editing; a different payload cannot reuse its code", async () => {
  const body = payload(), hash = await planImportDigest(canonicalPlanImportPayload(body));
  const imported = applyPrivatePlanImport(fixture(), body, hash, new Date(now).toISOString());
  const edited = applyAction(imported.state, admin, "saveDevelopmentPlan", { personId: "p1", goal: "Ручная корректировка после импорта" });
  const repeated = applyPrivatePlanImport(edited, body, hash, new Date(now + 1000).toISOString());
  assert.equal(repeated.state, edited); assert.equal(repeated.replayed, true); assert.deepEqual(repeated.receipt, imported.receipt);
  denied(() => applyPrivatePlanImport(edited, body, "0".repeat(64)), 409);
  const expectedPlan = parsePlanImportPayload(body).plan;
  const originalHash = await planImportDigest(canonicalPlanImportPayload({ title: body.title, plan: expectedPlan }));
  const readbackHash = await planImportDigest(canonicalPlanImportPayload({ title: body.title, plan: imported.state.developmentPlans.find(plan => plan.personId === "p1") }));
  assert.equal(readbackHash, originalHash);
});

test("unknown person, mismatched identity, existing plan and malformed import fail without writes", () => {
  const state = fixture(), body = payload(), hash = "a".repeat(64), before = structuredClone(state);
  denied(() => applyPrivatePlanImport(state, { ...body, personId: "unknown" }, hash), 409);
  denied(() => applyPrivatePlanImport(state, { ...body, expectedName: "Другая фамилия" }, hash), 409);
  denied(() => applyPrivatePlanImport(state, { ...body, personId: "p2", expectedName: "Другой участник" }, hash), 409);
  denied(() => applyPrivatePlanImport(state, { ...body, ownerId: "attacker" }, hash), 400);
  denied(() => applyPrivatePlanImport(state, { ...body, plan: { ...body.plan, personId: "p2" } }, hash), 400);
  denied(() => applyPrivatePlanImport(state, { ...body, plan: { goal: "Цель без источника" } }, hash), 400);
  assert.deepEqual(state, before);
});

test("competing imports use CAS: stale write loses, reloaded request sees receipt, no duplicate plan", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE workspaces (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)");
    const initial = fixture(), body = payload(), hash = await planImportDigest(canonicalPlanImportPayload(body));
    db.prepare("INSERT INTO workspaces VALUES ('main', 0, ?)").run(JSON.stringify(initial));
    const first = applyPrivatePlanImport(initial, body, hash), second = applyPrivatePlanImport(initial, body, hash);
    const cas = db.prepare("UPDATE workspaces SET document = ?, revision = revision + 1 WHERE id = 'main' AND revision = ?");
    assert.equal(cas.run(JSON.stringify(first.state), 0).changes, 1);
    assert.equal(cas.run(JSON.stringify(second.state), 0).changes, 0);
    const saved = db.prepare("SELECT revision, document FROM workspaces WHERE id = 'main'").get() as { revision: number; document: string };
    const retry = applyPrivatePlanImport(normalizeState(JSON.parse(saved.document)), body, hash);
    assert.equal(retry.replayed, true); assert.equal(saved.revision, 1);
    assert.equal(retry.state.developmentPlans.filter(plan => plan.personId === "p1").length, 1);
  } finally { db.close(); }
});
