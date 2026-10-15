import test from "node:test";
import assert from "node:assert/strict";
import type { User, WorkspaceState } from "../lib/model";

// Dynamic URL works both with Node's native TypeScript loader and the app's TS settings.
const { applyAction, calculateRace, claimMembership, DomainError, emptyState, mergeImport, normalizeState, resolveRole, restoreBootstrapState, scopeWorkspace } = await import(new URL("../lib/model.ts", import.meta.url).href) as typeof import("../lib/model");
const admin: User = { id: "admin", email: "owner@example.test", name: "Администратор" };
const manager: User = { id: "manager", email: "manager@example.test", name: "Тестовый руководитель" };
const outsider: User = { id: "outsider", email: "outsider@example.test", name: "Гость" };
const source = {
  people: [{ id: "p1", name: "Участник Альфа", email: "manager@example.test", userId: "untrusted", originalFields: { secret: "not imported" } }, { id: "p2", name: "Участник Бета" }],
  skills: [{ id: "s1", name: "Лидерство" }, { id: "s2", name: "Стратегия" }],
  events: [{ id: "e1", title: "Встреча", date: "2026-10-26", participantIds: ["p1", "p2"], type: "group", week: 1 }, { id: "e2", title: "Личная встреча Беты", participantIds: ["p2"], type: "individual" }],
  tasks: [{ id: "t1", title: "Практическая задача", personId: "p1", eventId: "e1", status: "done" }, { id: "t2", title: "Задача Беты", personId: "p2" }],
};
function fixture(): WorkspaceState {
  const state = mergeImport({ ...emptyState(), ownerId: admin.id }, source);
  return claimMembership(state, manager, []);
}
function rejects(operation: () => unknown, status: number): void {
  assert.throws(operation, (error: unknown) => error instanceof DomainError && error.status === status);
}

test("imports are idempotent and remove arbitrary original source fields", () => {
  const once = mergeImport(emptyState(), source);
  const twice = mergeImport(once, source);
  assert.deepEqual(twice, once);
  assert.equal(once.people[0].userId, null);
  assert.equal("originalFields" in once.people[0], false);
  assert.equal(once.tasks[0].status, "todo");
  assert.equal(once.assessments.length, 0);
  assert.deepEqual(calculateRace(once).map((row) => row.points), [0, 0]);
});

test("only configured verified email can claim owner; stable ID cannot be taken over by email", () => {
  const untouched = claimMembership(emptyState(), outsider, [admin.email]);
  assert.equal(untouched.ownerId, null);
  const owned = claimMembership(untouched, admin, [admin.email.toUpperCase()]);
  assert.equal(owned.ownerId, admin.id);
  assert.equal(resolveRole(owned, { ...admin, email: "new@example.test" }), "admin");
  const attempted = claimMembership(owned, { ...outsider, email: admin.email }, [admin.email]);
  assert.equal(attempted.ownerId, admin.id);
  assert.equal(resolveRole(attempted, outsider), "pending");
});

test("invitation binds once to stable ID and deactivated membership stops access", () => {
  const state = fixture();
  assert.equal(resolveRole(state, { ...manager, email: "changed@example.test" }), "manager");
  assert.equal(resolveRole(claimMembership(state, { ...outsider, email: manager.email }, []), outsider), "pending");
  const deactivated = applyAction(state, admin, "savePerson", { ...state.people[0], active: false });
  assert.equal(resolveRole(deactivated, manager), "pending");
});

test("manager receives own records and a race projection without other emails or skill scores", () => {
  let state = fixture();
  state = applyAction(state, admin, "saveAssessment", { personId: "p2", skillId: "s1", baseline: 1, current: 4, target: 5, evidence: "Тестовый пример", date: "2026-10-15" });
  const scoped = scopeWorkspace(state, 7, manager);
  assert.equal(scoped.role, "manager");
  assert.deepEqual(scoped.people.map((person) => person.id), ["p1"]);
  assert.deepEqual(scoped.events.map((event) => event.id), ["e1"]);
  assert.deepEqual(scoped.events[0].participantIds, ["p1", "p2"]);
  assert.deepEqual(scoped.tasks.map((task) => task.id), ["t1"]);
  assert.deepEqual(scoped.assessments, []);
  assert.deepEqual(scoped.audit, []);
  assert.equal("ownerId" in scoped, false);
  for (const row of scoped.race) assert.deepEqual(Object.keys(row).sort(), ["color", "name", "points", "progress", "title"]);
});

test("pending account has no roster, events, ratings or race", () => {
  const scoped = scopeWorkspace(fixture(), 2, outsider);
  for (const key of ["people", "events", "tasks", "skills", "assessments", "attendance", "audit", "race", "developmentPlans", "peerReviews", "eventRoster"] as const) assert.deepEqual(scoped[key], []);
  assert.equal(scoped.role, "pending");
});

test("all privileged writes reject manager and pending accounts", () => {
  const state = fixture();
  for (const action of ["saveEvent", "archiveEvent", "savePerson", "unlinkAccount", "saveTask", "setAttendance", "saveAssessment", "saveSettings", "saveDevelopmentPlan"]) {
    rejects(() => applyAction(state, manager, action, { role: "admin", userId: admin.id }), 403);
    rejects(() => applyAction(state, outsider, action, {}), 403);
  }
  rejects(() => applyAction(state, outsider, "completeTask", { id: "t1" }), 403);
});

test("manager can submit only own unfinished task; only admin confirms points", () => {
  const state = fixture();
  rejects(() => applyAction(state, manager, "completeTask", { id: "t2", status: "submitted" }), 404);
  rejects(() => applyAction(state, manager, "completeTask", { id: "unknown-task", status: "submitted" }), 404);
  rejects(() => applyAction(state, manager, "completeTask", { id: "t1", status: "done" }), 403);
  const submitted = applyAction(state, manager, "completeTask", { id: "t1", status: "submitted", evidence: "Ссылка на рабочий результат" });
  assert.equal(submitted.tasks[0].status, "submitted");
  assert.equal(calculateRace(submitted).find((row) => row.name === "Участник Альфа")?.points, 0);
  const done = applyAction(submitted, admin, "completeTask", { id: "t1", status: "done" }, "2026-10-15T12:00:00Z");
  assert.equal(calculateRace(done)[0].points, 30);
  rejects(() => applyAction(done, manager, "completeTask", { id: "t1", status: "submitted" }), 403);
  const repeat = applyAction(done, admin, "completeTask", { id: "t1", status: "done" }, "2026-10-16T12:00:00Z");
  assert.equal(calculateRace(repeat)[0].points, 30);
  assert.equal(repeat.tasks[0].completedAt, "2026-10-15T12:00:00Z");
});

test("attendance and skill gain score deterministically without double award", () => {
  let state = fixture();
  state = applyAction(state, admin, "setAttendance", { eventId: "e1", personId: "p1", status: "confirmed" });
  state = applyAction(state, admin, "setAttendance", { eventId: "e1", personId: "p1", status: "confirmed" });
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", baseline: 2, current: 3.5, target: 4, evidence: "Наблюдение", date: "2026-10-15" });
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", baseline: 2, current: 3.5, target: 4, evidence: "Наблюдение", date: "2026-10-15" });
  assert.equal(state.attendance.length, 1);
  assert.equal(state.assessments.length, 1);
  assert.equal(calculateRace(state)[0].points, 95);
  assert.equal(calculateRace(state)[0].progress, 9.5);
  assert.deepEqual(calculateRace(state), calculateRace(state));
});

test("missing baseline is not zero; negative growth adds no points", () => {
  let state = fixture();
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", baseline: null, current: 4, target: 5, evidence: "Наблюдение", date: "2026-10-15" });
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s2", baseline: 4, current: 2, target: 5, evidence: "Наблюдение", date: "2026-10-15" });
  assert.equal(state.assessments[0].baseline, null);
  assert.deepEqual(calculateRace(state).map((row) => row.points), [0, 0]);
});

test("finish denominator must be positive and calculation remains finite for legacy zero", () => {
  const state = fixture();
  rejects(() => applyAction(state, admin, "saveSettings", { ...state.settings, finishPoints: 0 }), 400);
  state.settings = { ...state.settings, finishPoints: 0 };
  for (const row of calculateRace(state)) assert.equal(row.progress, 0);
});

test("repeat import preserves confirmations, assessments, bound identities and archived state", () => {
  let state = fixture();
  state = applyAction(state, admin, "completeTask", { id: "t1", status: "done" });
  state = applyAction(state, admin, "setAttendance", { eventId: "e1", personId: "p1", status: "confirmed" });
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", baseline: 1, current: 2, target: 3, evidence: "Пример", date: "2026-10-15" });
  state = applyAction(state, admin, "archiveEvent", { id: "e1" });
  const after = mergeImport(state, source);
  assert.equal(after.people[0].userId, manager.id);
  assert.equal(after.tasks[0].status, "done");
  assert.equal(after.events[0].archived, true);
  assert.deepEqual(after.attendance, state.attendance);
  assert.deepEqual(after.assessments, state.assessments);
  assert.deepEqual(calculateRace(after), calculateRace(state));
});

test("validation rejects duplicates, malformed dates, cross-person assignment and email reuse", () => {
  const state = fixture();
  rejects(() => mergeImport(state, { ...source, events: [source.events[0], source.events[0]] }), 400);
  rejects(() => applyAction(state, admin, "saveEvent", { ...state.events[0], date: "2026-02-30" }), 400);
  rejects(() => applyAction(state, admin, "saveEvent", { ...state.events[0], participantIds: ["absent"] }), 404);
  rejects(() => applyAction(state, admin, "saveTask", { ...state.tasks[0], eventId: "e2" }), 400);
  rejects(() => applyAction(state, admin, "savePerson", { ...state.people[1], email: manager.email.toUpperCase() }), 400);
  rejects(() => applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", current: 4 }), 400);
});

test("audit retains latest 100 actions only", () => {
  let state = fixture();
  for (let index = 0; index < 110; index++) state = applyAction(state, admin, "saveSettings", state.settings, `test-${index}`);
  assert.equal(state.audit.length, 100);
  assert.equal(state.audit[0].at, "test-10");
  assert.equal(state.audit[99].at, "test-109");
});

test("unlink revokes access and prevents reclaim until admin sets a new invitation email", () => {
  const state = fixture();
  rejects(() => applyAction(state, manager, "unlinkAccount", { id: "p1" }), 403);
  const unlinked = applyAction(state, admin, "unlinkAccount", { id: "p1" });
  assert.equal(unlinked.people[0].email, null);
  assert.equal(unlinked.people[0].userId, null);
  assert.equal(resolveRole(unlinked, manager), "pending");
  assert.equal(claimMembership(unlinked, manager, []), unlinked);
  rejects(() => applyAction(unlinked, manager, "completeTask", { id: "t1", status: "submitted" }), 403);
  const invited = applyAction(unlinked, admin, "savePerson", { ...unlinked.people[0], email: outsider.email });
  const rebound = claimMembership(invited, outsider, []);
  assert.equal(rebound.people[0].userId, outsider.id);
  assert.equal(resolveRole(rebound, manager), "pending");
  assert.equal(resolveRole(rebound, outsider), "manager");
});

test("canonical IDs cannot accidentally erase membership or completed tasks on save or import", () => {
  let state = fixture();
  state = applyAction(state, admin, "completeTask", { id: "t1", status: "done" });
  state = applyAction(state, admin, "archiveEvent", { id: "e1" });
  state = applyAction(state, admin, "savePerson", { ...state.people[0], id: " p1 " });
  state = applyAction(state, admin, "saveTask", { ...state.tasks[0], id: " t1 " });
  assert.equal(state.people[0].userId, manager.id);
  assert.equal(state.tasks[0].status, "done");
  const padded = { people: source.people.map((person) => ({ ...person, id: ` ${person.id} ` })), events: source.events.map((event) => ({ ...event, id: ` ${event.id} ` })), skills: source.skills, tasks: source.tasks.map((task) => ({ ...task, id: ` ${task.id} ` })) };
  const imported = mergeImport(state, padded);
  assert.equal(imported.people[0].userId, manager.id);
  assert.equal(imported.tasks[0].status, "done");
  assert.equal(imported.events[0].archived, true);
  assert.equal(imported.people.length, 2);
});

test("manager projections omit future raw fields and internal event notes", () => {
  const state = fixture();
  Object.assign(state.people[0], { originalFields: { private: "hidden-private" } });
  Object.assign(state.events[0], { originalFields: { email: "hidden-private" }, comment: "hidden-private", sourceSheet: "hidden-private" });
  Object.assign(state.tasks[0], { reviewerHistory: "hidden-private" });
  Object.assign(state.skills[0], { internalBenchmarks: "hidden-private" });
  Object.assign(state.settings, { internalToken: "hidden-private" });
  const scoped = scopeWorkspace(state, 1, manager);
  assert.equal(JSON.stringify(scoped).includes("hidden-private"), false);
  assert.equal(scoped.events[0].comment, "");
  assert.equal(scoped.events[0].sourceRow, null);
  assert.equal(scoped.events[0].sourceSheet, "");
});

test("archived events leave the active manager calendar while earned history stays scored", () => {
  let state = fixture();
  state = applyAction(state, admin, "setAttendance", { eventId: "e1", personId: "p1", status: "confirmed" });
  state = applyAction(state, admin, "archiveEvent", { id: "e1" });
  const scoped = scopeWorkspace(state, 1, manager);
  assert.equal(scoped.events.length, 0);
  assert.equal(scoped.attendance[0].status, "confirmed");
  assert.equal(calculateRace(state).find((row) => row.name === "Участник Альфа")?.points, 20);
});

test("private bootstrap snapshot faithfully preserves recorded results and rejects foreign references", () => {
  let state = fixture();
  state = applyAction(state, admin, "setAttendance", { eventId: "e1", personId: "p1", status: "confirmed", note: "Участие проверено" });
  state = applyAction(state, admin, "completeTask", { id: "t1", status: "done", evidence: "Фактический результат" }, "2026-10-15T12:00:00.000Z");
  state = applyAction(state, admin, "saveAssessment", { personId: "p1", skillId: "s1", baseline: 2, current: 3, target: 4, evidence: "Наблюдение", date: "2026-10-15" });
  state = applyAction(state, admin, "archiveEvent", { id: "e1" });
  state = applyAction(state, admin, "savePerson", { ...state.people[1], active: false });
  const restored = restoreBootstrapState({ ...state, authCredentials: [{ passwordHash: "must not transfer" }] });
  assert.deepEqual(restored.tasks, state.tasks);
  assert.deepEqual(restored.attendance, state.attendance);
  assert.deepEqual(restored.assessments, state.assessments);
  assert.deepEqual(restored.events, state.events);
  assert.deepEqual(restored.settings, state.settings);
  assert.deepEqual(restored.audit, state.audit);
  assert.equal(calculateRace(restored)[0].points, 100);
  assert.deepEqual(calculateRace(restored), calculateRace(state));
  assert.equal(restored.ownerId, null);
  assert.ok(restored.people.every((person) => person.userId === null));
  assert.equal(restored.people[1].active, false);
  assert.equal("authCredentials" in restored, false);
  rejects(() => restoreBootstrapState({ ...state, attendance: [{ ...state.attendance[0], eventId: "foreign-event" }] }), 404);
  rejects(() => restoreBootstrapState({ ...state, tasks: [{ ...state.tasks[0], personId: "foreign-person" }] }), 404);
  rejects(() => restoreBootstrapState({ ...state, assessments: [{ ...state.assessments[0], skillId: "foreign-skill" }] }), 400);
  rejects(() => restoreBootstrapState({ ...state, tasks: [{ ...state.tasks[0], completedAt: null }] }), 400);
});

test("legacy normalization adds review fields without changing completion, XP or identity", () => {
  let state = fixture();
  state = applyAction(state, admin, "completeTask", { id: "t1", status: "done" }, "2026-10-15T12:00:00.000Z");
  const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  delete legacy.developmentPlans; delete legacy.peerReviews;
  for (const task of legacy.tasks as Record<string, unknown>[]) for (const key of ["rating", "ratingComment", "ratedAt", "ratedBy"]) delete task[key];
  const normalized = normalizeState(legacy);
  assert.deepEqual(normalized.developmentPlans, []);
  assert.deepEqual(normalized.peerReviews, []);
  assert.equal(normalized.tasks[0].rating, null);
  assert.equal(normalized.tasks[0].ratedAt, null);
  assert.equal(normalized.tasks[0].ratingComment, "");
  assert.equal(normalized.tasks[0].completedAt, "2026-10-15T12:00:00.000Z");
  assert.equal(normalized.tasks[0].status, "done");
  assert.equal(normalized.people[0].userId, manager.id);
  assert.deepEqual(calculateRace(normalized), calculateRace(state));
  assert.equal("developmentPlans" in legacy, false);
  const reviewed = applyAction(normalized, admin, "completeTask", { id: "t1", status: "done", rating: 4, ratingComment: "Критерии выполнены" });
  assert.deepEqual(normalizeState(reviewed), reviewed);
});

test("task ratings are integer 1–5, L&D-only, with server-controlled reviewer and time", () => {
  const state = fixture();
  for (const rating of [0, 6, 1.5, Number.NaN, "5"]) rejects(() => applyAction(state, admin, "completeTask", { id: "t1", status: "done", rating }), 400);
  for (const [key, value] of Object.entries({ rating: 5, ratingComment: "Подмена", ratedAt: "2020-01-01T00:00:00Z", ratedBy: admin.id })) {
    rejects(() => applyAction(state, manager, "completeTask", { id: "t1", status: "submitted", evidence: "Результат", [key]: value }), 403);
  }
  const low = applyAction(state, admin, "completeTask", { id: "t1", status: "done", rating: 1, ratingComment: "Нужно улучшение", ratedAt: "fake", ratedBy: "fake" }, "2026-10-15T10:00:00.000Z");
  assert.equal(low.tasks[0].rating, 1); assert.equal(low.tasks[0].ratedBy, admin.id); assert.equal(low.tasks[0].ratedAt, "2026-10-15T10:00:00.000Z");
  const high = applyAction(low, admin, "completeTask", { id: "t1", status: "done", rating: 5, ratingComment: "Результат улучшен" }, "2026-10-16T10:00:00.000Z");
  assert.equal(high.tasks[0].rating, 5); assert.equal(high.tasks[0].completedAt, low.tasks[0].completedAt);
  assert.equal(high.tasks[0].ratedAt, "2026-10-16T10:00:00.000Z");
  assert.deepEqual(calculateRace(high), calculateRace(low));
  const scoped = scopeWorkspace(high, 1, manager);
  assert.equal(scoped.tasks[0].rating, 5); assert.equal(scoped.tasks[0].ratingComment, "Результат улучшен"); assert.equal(scoped.tasks[0].ratedBy, null);
  const cleared = applyAction(high, admin, "completeTask", { id: "t1", status: "done", rating: null });
  assert.equal(cleared.tasks[0].rating, null); assert.equal(cleared.tasks[0].ratedAt, null);
});

test("development plans are unique per participant, editable by L&D and privately scoped", () => {
  let state = fixture();
  const plan = { personId: "p1", goal: "Развивать делегирование", successCriteria: "Две самостоятельные задачи команды", support: "Обратная связь", reviewDate: "2026-11-15" };
  rejects(() => applyAction(state, manager, "saveDevelopmentPlan", plan), 403);
  state = applyAction(state, admin, "saveDevelopmentPlan", plan);
  state = applyAction(state, admin, "saveDevelopmentPlan", { ...plan, goal: "Обновлённая цель" });
  state = applyAction(state, admin, "saveDevelopmentPlan", { ...plan, personId: "p2", goal: "Private beta development goal" });
  assert.equal(state.developmentPlans.length, 2);
  assert.equal(state.developmentPlans[0].id, "plan-p1");
  assert.equal(state.developmentPlans[0].goal, "Обновлённая цель");
  const own = scopeWorkspace(state, 2, manager);
  assert.equal(own.developmentPlans.length, 1);
  assert.equal(JSON.stringify(own).includes("Private beta development goal"), false);
  rejects(() => applyAction(state, admin, "saveDevelopmentPlan", { ...plan, personId: "absent" }), 404);
  rejects(() => applyAction(state, admin, "saveDevelopmentPlan", { ...plan, goal: "" }), 400);
  rejects(() => applyAction(state, admin, "saveDevelopmentPlan", { ...plan, reviewDate: "2026-02-30" }), 400);
});

function peerFixture() {
  let state = fixture();
  const beta: User = { id: "beta-user", email: "beta@example.test", name: "Бета" };
  const gamma: User = { id: "gamma-user", email: "gamma@example.test", name: "Гамма" };
  state = applyAction(state, admin, "savePerson", { ...state.people[0], title: "Руководитель Альфа" });
  state = applyAction(state, admin, "savePerson", { ...state.people[1], email: beta.email, title: "Руководитель Бета" });
  state = applyAction(state, admin, "savePerson", { id: "p3", name: "Участник Гамма", email: gamma.email, title: "Руководитель Гамма" });
  state = claimMembership(claimMembership(state, beta, []), gamma, []);
  state = applyAction(state, admin, "saveEvent", { id: "e3", type: "team", title: "Команда Беты и Гаммы", participantIds: ["p2", "p3"] });
  return { state, beta, gamma };
}

test("peer reviews require an actual shared-event participant and cannot impersonate colleagues", () => {
  const { state, beta } = peerFixture();
  const review = { eventId: "e1", personId: "p2", score: 4, comment: "Помог структурировать решение" };
  for (const score of [0, 6, 2.5, "4", null]) rejects(() => applyAction(state, manager, "savePeerReview", { ...review, score }), 400);
  rejects(() => applyAction(state, admin, "savePeerReview", { ...review, reviewerPersonId: "p1" }), 403);
  rejects(() => applyAction(state, manager, "savePeerReview", { ...review, reviewerPersonId: "p2" }), 403);
  rejects(() => applyAction(state, manager, "savePeerReview", { ...review, personId: "p1" }), 403);
  rejects(() => applyAction(state, manager, "savePeerReview", { ...review, eventId: "e3", personId: "p3" }), 403);
  rejects(() => applyAction(state, beta, "savePeerReview", { ...review, eventId: "e2", personId: "p1" }), 403);
  const initial = applyAction(state, manager, "savePeerReview", { ...review, reviewerPersonId: "p1", updatedAt: "forged-time" }, "2026-10-15T10:00:00.000Z");
  assert.equal(initial.peerReviews[0].reviewerPersonId, "p1");
  assert.equal(initial.peerReviews[0].updatedAt, "2026-10-15T10:00:00.000Z");
  const updated = applyAction(initial, manager, "savePeerReview", { ...review, score: 5 });
  assert.equal(updated.peerReviews.length, 1); assert.equal(updated.peerReviews[0].score, 5);
  assert.deepEqual(calculateRace(updated), calculateRace(state));
  const archived = applyAction(state, admin, "archiveEvent", { id: "e1" });
  rejects(() => applyAction(archived, manager, "savePeerReview", review), 403);
  const inactive = applyAction(state, admin, "savePerson", { ...state.people[1], active: false });
  rejects(() => applyAction(inactive, manager, "savePeerReview", review), 403);
});

test("event roster reveals only shared-event names and titles while peer reviews stay received or written", () => {
  const { state: initial, beta } = peerFixture();
  let state = applyAction(initial, manager, "savePeerReview", { eventId: "e1", personId: "p2", score: 1, comment: "Альфа → Бета" });
  state = applyAction(state, beta, "savePeerReview", { eventId: "e1", personId: "p1", score: 5, comment: "Бета → Альфа" });
  state = applyAction(state, beta, "savePeerReview", { eventId: "e3", personId: "p3", score: 3, comment: "Private beta gamma feedback" });
  const scoped = scopeWorkspace(state, 3, manager);
  assert.deepEqual(scoped.people.map((person) => person.id), ["p1"]);
  assert.deepEqual(scoped.eventRoster.map((row) => row.personId), ["p1", "p2"]);
  assert.ok(scoped.eventRoster.every((row) => row.eventId === "e1"));
  for (const row of scoped.eventRoster) assert.deepEqual(Object.keys(row).sort(), ["eventId", "name", "personId", "title"]);
  assert.equal(scoped.eventRoster[1].title, "Руководитель Бета");
  assert.equal(scoped.peerReviews.length, 2);
  assert.equal(JSON.stringify(scoped).includes("Private beta gamma feedback"), false);
  assert.equal(JSON.stringify(scoped).includes(beta.email), false);
  assert.equal(JSON.stringify(scoped).includes(beta.id), false);
  assert.equal(scopeWorkspace(state, 3, admin).peerReviews.length, 3);
  assert.equal(scoped.race.find((row) => row.name === "Участник Бета")?.title, "Руководитель Бета");
});

test("plan re-import preserves manual title, inactive account, task review and development records", () => {
  let state = fixture();
  state = applyAction(state, admin, "savePerson", { ...state.people[0], title: "Должность задана L&D", active: false });
  state = applyAction(state, admin, "completeTask", { id: "t1", status: "done", rating: 4, ratingComment: "Подтверждённый результат" });
  state = applyAction(state, admin, "saveDevelopmentPlan", { personId: "p1", goal: "Ручная цель", support: "Наставник" });
  const imported = mergeImport(state, { ...source, people: [{ ...source.people[0], title: "   ", active: true, userId: "forged" }, source.people[1]], tasks: source.tasks.map((task) => ({ ...task, rating: 1, ratingComment: "Do not import a score" })) });
  assert.equal(imported.people[0].title, "Должность задана L&D");
  assert.equal(imported.people[0].active, false);
  assert.equal(imported.people[0].userId, manager.id);
  assert.equal(imported.tasks[0].rating, 4);
  assert.equal(imported.tasks[0].ratingComment, "Подтверждённый результат");
  assert.deepEqual(imported.developmentPlans, state.developmentPlans);
  assert.deepEqual(imported.assessments, state.assessments);
});

test("private snapshot preserves task ratings, individual plans and peer review history", () => {
  const { state: initial } = peerFixture();
  let state = applyAction(initial, manager, "savePeerReview", { eventId: "e1", personId: "p2", score: 5, comment: "Обратная связь" });
  state = applyAction(state, admin, "completeTask", { id: "t1", status: "done", rating: 3, ratingComment: "Проверено L&D" });
  state = applyAction(state, admin, "saveDevelopmentPlan", { personId: "p1", goal: "Личная цель", successCriteria: "Критерий", support: "Поддержка" });
  const restored = restoreBootstrapState(state);
  assert.deepEqual(restored.tasks, state.tasks);
  assert.deepEqual(restored.developmentPlans, state.developmentPlans);
  assert.deepEqual(restored.peerReviews, state.peerReviews);
  assert.deepEqual(calculateRace(restored), calculateRace(state));
});

test("historical peer feedback remains identifiable without widening profile or review access", () => {
  const { state: initial, beta } = peerFixture();
  let state = applyAction(initial, beta, "savePeerReview", { eventId: "e1", personId: "p1", score: 4, comment: "Исторический отзыв Беты" });
  state = applyAction(state, beta, "savePeerReview", { eventId: "e3", personId: "p3", score: 2, comment: "Private unrelated historical review" });
  state = applyAction(state, admin, "saveEvent", { ...state.events[0], participantIds: ["p1"] });
  let scoped = scopeWorkspace(state, 1, manager);
  assert.deepEqual(scoped.eventRoster.map((person) => person.personId), ["p1"]);
  assert.equal(scoped.peerReviews[0].reviewerName, "Участник Бета");
  assert.equal(scoped.peerReviews[0].personName, "Участник Альфа");
  assert.equal(scoped.peerReviews[0].eventTitle, "Встреча");
  state = applyAction(state, admin, "archiveEvent", { id: "e1" });
  state = applyAction(state, admin, "savePerson", { ...state.people[1], active: false });
  scoped = scopeWorkspace(state, 2, manager);
  assert.deepEqual(scoped.eventRoster, []);
  assert.deepEqual(scoped.events, []);
  assert.deepEqual(scoped.people.map((person) => person.id), ["p1"]);
  assert.equal(scoped.peerReviews.length, 1);
  assert.equal(scoped.peerReviews[0].reviewerName, "Участник Бета");
  for (const privateValue of [beta.id, beta.email, "Private unrelated historical review"]) assert.equal(JSON.stringify(scoped).includes(privateValue), false);
  assert.equal(scopeWorkspace(state, 2, admin).peerReviews[0].reviewerName, "Участник Бета");
  assert.equal("reviewerName" in state.peerReviews[0], false, "display fields must not enter durable state");
});
