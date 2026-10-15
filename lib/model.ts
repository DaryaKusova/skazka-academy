/** Shared contract. Private source data is imported at runtime only. */
export type Role = "admin" | "manager" | "pending";
export type User = { id: string; email: string; name: string };
export type Person = { id: string; name: string; email: string | null; userId: string | null; title: string; color: string; active: boolean };
export type LearningEvent = {
  id: string; sourceSheet: string; sourceRow: number | null; date: string | null;
  week: string; type: "group" | "individual" | "team"; title: string; skill: string;
  description: string; format: string; expectedResult: string; participantIds: string[];
  stage: string; owner: string; planLink: string; status: "planned" | "draft";
  originalStatus: string; comment: string; archived: boolean;
};
export type Skill = { id: string; name: string };
export type Task = {
  id: string; personId: string; eventId: string | null; title: string; description: string;
  dueDate: string | null; status: "todo" | "submitted" | "done"; evidence: string; completedAt: string | null;
};
export type Assessment = {
  id: string; personId: string; skillId: string; baseline: number | null; current: number | null;
  target: number | null; evidence: string; date: string | null;
};
export type Attendance = { id: string; eventId: string; personId: string; status: "pending" | "confirmed" | "absent"; note: string };
export type Settings = { eventPoints: number; taskPoints: number; skillPointWeight: number; finishPoints: number };
export type AuditEntry = { id: string; at: string; actorId: string; actorName: string; action: string; entityId: string };
export type RaceEntry = { name: string; color: string; points: number; progress: number };
export type WorkspaceState = {
  ownerId: string | null; people: Person[]; events: LearningEvent[]; tasks: Task[]; skills: Skill[];
  assessments: Assessment[]; attendance: Attendance[]; settings: Settings; audit: AuditEntry[];
};
export type Workspace = Omit<WorkspaceState, "ownerId"> & { user: User; role: Role; revision: number; race: RaceEntry[] };
export type Action = "saveEvent" | "archiveEvent" | "savePerson" | "unlinkAccount" | "saveTask" | "completeTask" | "setAttendance" | "saveAssessment" | "saveSettings";
export const DEFAULT_SETTINGS: Settings = { eventPoints: 20, taskPoints: 30, skillPointWeight: 50, finishPoints: 1000 };
export const PERSON_COLORS = ["#008d95", "#9a70c4", "#e3a22f", "#3b89bf", "#e48679", "#70a671", "#bd73a5", "#577d9b", "#a28c61", "#4d9f8e", "#9e7eae"];

export class DomainError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.name = "DomainError"; this.status = status; }
}
export function emptyState(): WorkspaceState {
  return { ownerId: null, people: [], events: [], tasks: [], skills: [], assessments: [], attendance: [], settings: { ...DEFAULT_SETTINGS }, audit: [] };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("Ожидается JSON-объект.");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 10000, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new DomainError(`Поле «${field}» должно быть текстом.`);
  const result = value.trim();
  if (result.length > max) throw new DomainError(`Поле «${field}» слишком длинное (до ${max} символов).`);
  return result;
}
function required(value: unknown, field: string, max = 300): string {
  const result = text(value, field, max);
  if (!result) throw new DomainError(`Заполните поле «${field}».`);
  return result;
}
function identifier(value: unknown, field = "id"): string {
  const result = required(value, field, 160);
  if (/[\u0000-\u001f]/.test(result) || result.includes("::")) throw new DomainError(`Недопустимый идентификатор «${field}».`);
  return result;
}
function makeId(value: unknown): string { return value ? identifier(value) : crypto.randomUUID(); }
function enumeration<T extends string>(value: unknown, choices: readonly T[], fallback?: T): T {
  if ((value === undefined || value === null) && fallback) return fallback;
  if (typeof value !== "string" || !choices.includes(value as T)) throw new DomainError(`Допустимые значения: ${choices.join(", ")}.`);
  return value as T;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new DomainError("Ожидается логическое значение.");
  return value;
}
function numeric(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new DomainError(`Поле «${field}»: число от ${min} до ${max}.`);
  return value;
}
function nullableScore(value: unknown): number | null {
  return value === undefined || value === null || value === "" ? null : numeric(value, "оценка", 0, 5);
}
function date(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const result = required(value, "дата", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new DomainError("Дата должна быть действительной датой ГГГГ-ММ-ДД.");
  return result;
}
function list(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new DomainError(`Поле «${field}»: массив до ${max} элементов.`);
  return value;
}
export function normalizeEmail(value: unknown): string | null {
  const result = text(value, "email", 254).toLowerCase();
  if (!result) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new DomainError("Укажите корректный email для приглашения.");
  return result;
}
export function resolveRole(state: WorkspaceState, user: User): Role {
  if (state.ownerId === user.id) return "admin";
  return state.people.some((person) => person.active && person.userId === user.id) ? "manager" : "pending";
}
/** Records are counted once; unknown scores never become zero. */
export function calculateRace(state: WorkspaceState): RaceEntry[] {
  return state.people.filter((person) => person.active).map((person) => {
    const attendance = new Set(state.attendance.filter((entry) => entry.personId === person.id && entry.status === "confirmed" && state.events.some((event) => event.id === entry.eventId)).map((entry) => entry.eventId));
    const tasks = new Set(state.tasks.filter((task) => task.personId === person.id && task.status === "done").map((task) => task.id));
    const latest = new Map(state.assessments.filter((entry) => entry.personId === person.id).map((entry) => [entry.skillId, entry]));
    const gain = [...latest.values()].reduce((total, entry) => total + (entry.baseline !== null && entry.current !== null ? Math.max(0, entry.current - entry.baseline) : 0), 0);
    const points = Math.round((attendance.size * state.settings.eventPoints + tasks.size * state.settings.taskPoints + gain * state.settings.skillPointWeight) * 100) / 100;
    // Also guards an old or externally corrupted zero denominator.
    const progress = state.settings.finishPoints > 0 ? Math.min(100, Math.max(0, Math.round(points / state.settings.finishPoints * 1000) / 10)) : 0;
    return { name: person.name, color: person.color, points, progress };
  }).sort((left, right) => right.points - left.points || left.name.localeCompare(right.name, "ru"));
}
export function scopeWorkspace(state: WorkspaceState, revision: number, user: User): Workspace {
  const role = resolveRole(state, user);
  const { ownerId: _ownerId, ...data } = state;
  void _ownerId;
  if (role === "pending") return { user, role, revision, people: [], events: [], tasks: [], skills: [], assessments: [], attendance: [], audit: [], settings: { ...DEFAULT_SETTINGS }, race: [] };
  const race = calculateRace(state);
  if (role === "admin") return { ...data, user, role, revision, race };
  const ownIds = new Set(state.people.filter((person) => person.active && person.userId === user.id).map((person) => person.id));
  return {
    user, role, revision, race, audit: [],
    settings: { eventPoints: state.settings.eventPoints, taskPoints: state.settings.taskPoints, skillPointWeight: state.settings.skillPointWeight, finishPoints: state.settings.finishPoints },
    skills: state.skills.map(({ id, name }) => ({ id, name })),
    people: state.people.filter((person) => ownIds.has(person.id)).map(({ id, name, email, userId, title, color, active }) => ({ id, name, email, userId, title, color, active })),
    // Explicit projections prevent future storage fields, raw workbook metadata and
    // editorial notes from silently becoming visible in a participant response.
    events: state.events.filter((event) => !event.archived && event.participantIds.some((id) => ownIds.has(id))).map((event) => ({
      id: event.id, date: event.date, week: event.week, type: event.type, title: event.title, skill: event.skill,
      description: event.description, format: event.format, expectedResult: event.expectedResult,
      participantIds: event.participantIds.filter((id) => ownIds.has(id)), stage: event.stage, owner: event.owner,
      planLink: event.planLink, status: event.status, archived: false, sourceSheet: "", sourceRow: null,
      originalStatus: "", comment: "",
    })),
    tasks: state.tasks.filter((task) => ownIds.has(task.personId)).map(({ id, personId, eventId, title, description, dueDate, status, evidence, completedAt }) => ({ id, personId, eventId, title, description, dueDate, status, evidence, completedAt })),
    assessments: state.assessments.filter((entry) => ownIds.has(entry.personId)).map(({ id, personId, skillId, baseline, current, target, evidence, date }) => ({ id, personId, skillId, baseline, current, target, evidence, date })),
    attendance: state.attendance.filter((entry) => ownIds.has(entry.personId)).map(({ id, eventId, personId, status, note }) => ({ id, eventId, personId, status, note })),
  };
}
function upsert<T extends { id: string }>(values: T[], item: T): T[] {
  return values.some((value) => value.id === item.id) ? values.map((value) => value.id === item.id ? item : value) : [...values, item];
}
function existingById<T extends { id: string }>(values: T[], rawId: unknown): T | undefined {
  const id = rawId ? identifier(rawId) : null;
  return id ? values.find((value) => value.id === id) : undefined;
}
function personExists(state: WorkspaceState, id: string): void {
  if (!state.people.some((person) => person.id === id)) throw new DomainError("Участник не найден.", 404);
}
function eventExists(state: WorkspaceState, id: string): LearningEvent {
  const event = state.events.find((item) => item.id === id);
  if (!event) throw new DomainError("Мероприятие не найдено.", 404);
  return event;
}
function parsePerson(raw: unknown, index: number, existing?: Person): Person {
  const value = object(raw);
  const color = text(value.color, "цвет", 7, existing?.color ?? PERSON_COLORS[index % PERSON_COLORS.length]);
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new DomainError("Цвет должен быть в формате #RRGGBB.");
  return { id: makeId(value.id), name: required(value.name, "ФИО"), email: normalizeEmail(value.email), userId: existing?.userId ?? null, title: text(value.title, "должность", 300), color, active: boolean(value.active, true) };
}
function parseEvent(raw: unknown, state: WorkspaceState): LearningEvent {
  const value = object(raw);
  const participantIds = [...new Set(list(value.participantIds ?? [], "участники", 500).map((id) => identifier(id, "участник")))];
  participantIds.forEach((id) => personExists(state, id));
  return {
    id: makeId(value.id), sourceSheet: text(value.sourceSheet, "лист", 300), sourceRow: value.sourceRow === undefined || value.sourceRow === null ? null : numeric(value.sourceRow, "строка", 1, 1000000),
    date: date(value.date), week: typeof value.week === "number" ? String(value.week) : text(value.week, "неделя", 100),
    type: enumeration(value.type, ["group", "individual", "team"], "group"), title: required(value.title, "название", 600), skill: text(value.skill, "компетенция", 600),
    description: text(value.description, "описание"), format: text(value.format, "формат"), expectedResult: text(value.expectedResult, "результат"), participantIds,
    stage: text(value.stage, "этап", 600), owner: text(value.owner, "ответственный", 600), planLink: text(value.planLink, "связь с планом", 3000),
    status: enumeration(value.status, ["planned", "draft"], "planned"), originalStatus: text(value.originalStatus, "исходный статус", 600), comment: text(value.comment, "комментарий"), archived: boolean(value.archived, false),
  };
}
function parseTask(raw: unknown, state: WorkspaceState, existing?: Task): Task {
  const value = object(raw), personId = identifier(value.personId, "участник");
  personExists(state, personId);
  if (existing && existing.status !== "todo" && existing.personId !== personId) throw new DomainError("Сначала верните задачу в работу, чтобы изменить исполнителя.");
  const eventId = value.eventId ? identifier(value.eventId, "мероприятие") : null;
  if (eventId && !eventExists(state, eventId).participantIds.includes(personId)) throw new DomainError("Задачу можно связать только с мероприятием участника.");
  return { id: makeId(value.id), personId, eventId, title: required(value.title, "задача", 600), description: text(value.description, "описание"), dueDate: date(value.dueDate), status: existing?.status ?? "todo", evidence: existing?.evidence ?? "", completedAt: existing?.completedAt ?? null };
}
function validateUniqueMembership(people: Person[]): void {
  const emails = people.map((person) => person.email).filter(Boolean);
  if (new Set(emails).size !== emails.length) throw new DomainError("Этот email уже назначен другому участнику.");
  const users = people.map((person) => person.userId).filter(Boolean);
  if (new Set(users).size !== users.length) throw new DomainError("Аккаунт уже связан с другим участником.");
}
function appendAudit(state: WorkspaceState, user: User, action: string, entityId: string, now: string): WorkspaceState {
  return { ...state, audit: [...state.audit, { id: crypto.randomUUID(), at: now, actorId: user.id, actorName: user.name, action, entityId }].slice(-100) };
}
export function applyAction(state: WorkspaceState, user: User, action: string, raw: unknown, now = new Date().toISOString()): WorkspaceState {
  const role = resolveRole(state, user);
  if (role === "pending" || (role !== "admin" && action !== "completeTask")) throw new DomainError("Недостаточно прав для изменения этих данных.", 403);
  const value = object(raw);
  const next = { ...state }; let entityId = "";
  switch (action) {
    case "saveEvent": {
      const event = parseEvent(value, state); entityId = event.id;
      next.events = upsert(state.events, event); break;
    }
    case "archiveEvent": {
      entityId = identifier(value.id); eventExists(state, entityId);
      next.events = state.events.map((event) => event.id === entityId ? { ...event, archived: true } : event); break;
    }
    case "savePerson": {
      const existing = existingById(state.people, value.id);
      const person = parsePerson(value, state.people.length, existing); entityId = person.id;
      next.people = upsert(state.people, person); validateUniqueMembership(next.people); break;
    }
    case "unlinkAccount": {
      entityId = identifier(value.id); personExists(state, entityId);
      // Clearing the email as well prevents the old account from immediately claiming again.
      next.people = state.people.map((person) => person.id === entityId ? { ...person, userId: null, email: null } : person);
      break;
    }
    case "saveTask": {
      const task = parseTask(value, state, existingById(state.tasks, value.id)); entityId = task.id;
      next.tasks = upsert(state.tasks, task); break;
    }
    case "completeTask": {
      entityId = identifier(value.id);
      const ownPersonIds = new Set(state.people.filter((person) => person.active && person.userId === user.id).map((person) => person.id));
      const task = state.tasks.find((item) => item.id === entityId && (role === "admin" || ownPersonIds.has(item.personId)));
      if (!task) throw new DomainError("Задача не найдена.", 404);
      const status = enumeration(value.status, ["todo", "submitted", "done"], role === "admin" ? "done" : "submitted");
      if (role !== "admin" && (status !== "submitted" || task.status === "done")) throw new DomainError("Руководитель может только отправить свою незавершённую задачу на подтверждение.", 403);
      const evidence = text(value.evidence, "подтверждение", 10000, task.evidence);
      next.tasks = upsert(state.tasks, { ...task, status, evidence, completedAt: status === "done" ? task.completedAt ?? now : null }); break;
    }
    case "setAttendance": {
      const eventId = identifier(value.eventId, "мероприятие"), personId = identifier(value.personId, "участник");
      personExists(state, personId);
      if (!eventExists(state, eventId).participantIds.includes(personId)) throw new DomainError("Участник не назначен на это мероприятие.");
      entityId = `${eventId}::${personId}`;
      next.attendance = upsert(state.attendance, { id: entityId, eventId, personId, status: enumeration(value.status, ["pending", "confirmed", "absent"]), note: text(value.note, "примечание") }); break;
    }
    case "saveAssessment": {
      const personId = identifier(value.personId, "участник"), skillId = identifier(value.skillId, "компетенция");
      personExists(state, personId);
      if (!state.skills.some((skill) => skill.id === skillId)) throw new DomainError("Компетенция не найдена.", 404);
      entityId = `${personId}::${skillId}`;
      const assessment: Assessment = { id: entityId, personId, skillId, baseline: nullableScore(value.baseline), current: nullableScore(value.current), target: nullableScore(value.target), evidence: text(value.evidence, "основание оценки"), date: date(value.date) };
      if (assessment.current !== null && (!assessment.date || !assessment.evidence)) throw new DomainError("Для текущей оценки укажите дату и основание.");
      next.assessments = upsert(state.assessments, assessment); break;
    }
    case "saveSettings": {
      next.settings = { eventPoints: numeric(value.eventPoints, "баллы за мероприятие", 0, 10000), taskPoints: numeric(value.taskPoints, "баллы за задачу", 0, 10000), skillPointWeight: numeric(value.skillPointWeight, "баллы за рост навыка", 0, 10000), finishPoints: numeric(value.finishPoints, "финиш", 1, 10000000) }; entityId = "settings"; break;
    }
    default: throw new DomainError("Неизвестное действие.");
  }
  if (next.people.length > 500 || next.events.length > 5000 || next.tasks.length > 10000) throw new DomainError("Достигнут лимит рабочей области.", 413);
  return appendAudit(next, user, action, entityId, now);
}
export type ImportData = { people: unknown[]; events: unknown[]; skills: unknown[]; tasks?: unknown[] };
/** Merge stable source ids. Do not overwrite confirmations, scores or completed tasks. */
export function mergeImport(state: WorkspaceState, raw: unknown): WorkspaceState {
  const value = object(raw), next = { ...state };
  const people = list(value.people, "участники", 500), events = list(value.events, "мероприятия", 5000), skills = list(value.skills, "компетенции", 200), tasks = value.tasks === undefined ? [] : list(value.tasks, "задачи", 10000);
  for (const [name, rows] of [["участники", people], ["мероприятия", events], ["компетенции", skills], ["задачи", tasks]] as const) {
    const ids = rows.map((row) => identifier(object(row).id));
    if (new Set(ids).size !== ids.length) throw new DomainError(`В импорте повторяются идентификаторы: ${name}.`);
  }
  for (const rawPerson of people) {
    const person = object(rawPerson), existing = existingById(next.people, person.id);
    const parsed = parsePerson({ ...existing, ...person, email: person.email || existing?.email || null }, next.people.length, existing);
    next.people = upsert(next.people, parsed);
  }
  validateUniqueMembership(next.people);
  for (const rawSkill of skills) {
    const skill = object(rawSkill);
    next.skills = upsert(next.skills, { id: identifier(skill.id), name: required(skill.name, "компетенция", 600) });
  }
  for (const rawEvent of events) {
    const event = object(rawEvent), existing = existingById(next.events, event.id);
    const parsed = parseEvent({ ...existing, ...event, archived: existing?.archived ?? false }, next);
    next.events = upsert(next.events, parsed);
  }
  for (const rawTask of tasks) {
    const task = object(rawTask), existing = existingById(next.tasks, task.id);
    next.tasks = upsert(next.tasks, parseTask({ ...existing, ...task }, next, existing));
  }
  if (next.people.length > 500 || next.events.length > 5000 || next.tasks.length > 10000 || next.skills.length > 200) throw new DomainError("Достигнут лимит рабочей области.", 413);
  return next;
}
export function recordImport(state: WorkspaceState, user: User, now = new Date().toISOString()): WorkspaceState {
  return appendAudit(state, user, "import", "workspace", now);
}
/** One-time private migration of already-recorded facts, never a plan re-import.
 * Authentication links and ownerId are deliberately excluded from the snapshot. */
export function restoreBootstrapState(raw: unknown): WorkspaceState {
  const value = object(raw);
  const state = mergeImport(emptyState(), { people: value.people, events: value.events, skills: value.skills, tasks: [] });
  const rawEvents = new Map(list(value.events, "мероприятия", 5000).map((item) => { const event = object(item); return [identifier(event.id), event] as const; }));
  state.events = state.events.map((event) => ({ ...event, archived: boolean(rawEvents.get(event.id)?.archived, false) }));
  function timestamp(input: unknown, field: string): string {
    const result = required(input, field, 40);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))) throw new DomainError(`Некорректная дата «${field}».`);
    date(result.slice(0, 10));
    return result;
  }
  function unique<T extends { id: string }>(rows: T[], field: string): T[] {
    if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new DomainError(`Повторяющиеся записи: ${field}.`);
    return rows;
  }
  state.tasks = unique(list(value.tasks, "задачи", 10000).map((rawTask) => {
    const task = object(rawTask), id = identifier(task.id), eventId = task.eventId ? identifier(task.eventId, "мероприятие") : null;
    if (eventId) eventExists(state, eventId);
    // A historical task can remain linked after an administrator changes the event's
    // current participant list. Referenced records must still exist in the snapshot.
    const parsed = parseTask({ ...task, id, eventId: null }, state);
    const status = enumeration(task.status, ["todo", "submitted", "done"]);
    const completedAt = task.completedAt === null || task.completedAt === undefined ? null : timestamp(task.completedAt, "дата выполнения");
    if ((status === "done") !== (completedAt !== null)) throw new DomainError("Статус задачи не соответствует сохранённой дате выполнения.");
    return { ...parsed, eventId, status, evidence: text(task.evidence, "подтверждение"), completedAt };
  }), "задачи");
  state.attendance = unique(list(value.attendance, "участие", 100000).map((rawEntry) => {
    const entry = object(rawEntry), eventId = identifier(entry.eventId, "мероприятие"), personId = identifier(entry.personId, "участник");
    eventExists(state, eventId); personExists(state, personId);
    return { id: `${eventId}::${personId}`, eventId, personId, status: enumeration(entry.status, ["pending", "confirmed", "absent"]), note: text(entry.note, "примечание") };
  }), "участие");
  state.assessments = unique(list(value.assessments, "оценки", 100000).map((rawEntry) => {
    const entry = object(rawEntry), personId = identifier(entry.personId, "участник"), skillId = identifier(entry.skillId, "компетенция");
    personExists(state, personId);
    if (!state.skills.some((skill) => skill.id === skillId)) throw new DomainError("Компетенция из снимка не найдена.");
    const assessment: Assessment = { id: `${personId}::${skillId}`, personId, skillId, baseline: nullableScore(entry.baseline), current: nullableScore(entry.current), target: nullableScore(entry.target), evidence: text(entry.evidence, "основание оценки"), date: date(entry.date) };
    if (assessment.current !== null && (!assessment.date || !assessment.evidence)) throw new DomainError("У сохранённой оценки отсутствуют дата или основание.");
    return assessment;
  }), "оценки");
  const settings = object(value.settings);
  state.settings = { eventPoints: numeric(settings.eventPoints, "баллы за мероприятие", 0, 10000), taskPoints: numeric(settings.taskPoints, "баллы за задачу", 0, 10000), skillPointWeight: numeric(settings.skillPointWeight, "баллы за рост навыка", 0, 10000), finishPoints: numeric(settings.finishPoints, "финиш", 1, 10000000) };
  state.audit = unique(list(value.audit ?? [], "история", 100).map((rawEntry) => {
    const entry = object(rawEntry);
    return { id: identifier(entry.id), at: timestamp(entry.at, "дата изменения"), actorId: required(entry.actorId, "автор", 300), actorName: required(entry.actorName, "имя автора", 600), action: required(entry.action, "действие", 100), entityId: text(entry.entityId, "объект изменения", 400) };
  }), "история");
  return state;
}
/** Email claims a membership once; subsequent access follows the stable site user id. */
export function claimMembership(state: WorkspaceState, user: User, adminEmails: string[], now = new Date().toISOString()): WorkspaceState {
  const email = normalizeEmail(user.email);
  if (!state.ownerId && email && adminEmails.map((item) => item.trim().toLowerCase()).includes(email)) {
    // ADMIN_EMAILS is configured only from the verified site owner's account. The Sites
    // dispatch authenticates headers; atomic CAS prevents concurrent owner claims.
    return appendAudit({ ...state, ownerId: user.id }, user, "claimOwner", "workspace", now);
  }
  if (resolveRole(state, user) !== "pending") return state;
  const invited = state.people.find((person) => person.active && !person.userId && person.email && person.email === email);
  if (!invited) return state;
  return appendAudit({ ...state, people: state.people.map((person) => person.id === invited.id ? { ...person, userId: user.id } : person) }, user, "acceptInvitation", invited.id, now);
}
