import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

const { prepareExportData, exportSheets, buildXlsx, buildDocx } = await import(new URL("../lib/exports.ts", import.meta.url).href) as typeof import("../lib/exports");
const { exportFixture } = await import(new URL("./fixtures/export-workspace.ts", import.meta.url).href) as typeof import("./fixtures/export-workspace");
const generatedAt = "2026-10-30T12:00:00Z";

// Read ZIP central-directory offsets so data-descriptor and deflated entries both work.
function zipEntries(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes), entries = new Map<string, string>();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "valid ZIP end record");
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20), nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32), local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(start, start + size);
    if (name.endsWith(".xml") || name.endsWith(".rels")) entries.set(name, (method === 8 ? inflateRawSync(packed) : packed).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("exports use an explicit projection without contact fields, account IDs, audit or source metadata", () => {
  const data = prepareExportData(exportFixture(), {}, generatedAt);
  assert.equal(data.people.length, 2);
  assert.equal(data.events.length, 2);
  const serialized = JSON.stringify(data);
  for (const forbidden of ["PRIVATE_ADMIN", "PRIVATE_A_EMAIL", "PRIVATE_B_EMAIL", "PRIVATE_USER", "PRIVATE_RATER", "PRIVATE_AUDIT", "INTERNAL_NOTE", "INTERNAL_SOURCE", "INTERNAL_ORIGINAL"]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(serialized.includes("Архивная встреча"), false);
});

test("manager export defensively scopes individual data while preserving shared event roster", () => {
  const workspace = exportFixture();
  workspace.role = "manager";
  workspace.user.id = "PRIVATE_USER_A";
  const data = prepareExportData(workspace, {}, generatedAt);
  assert.deepEqual(data.people.map((p) => p.id), ["p1"]);
  assert.deepEqual(data.events.map((e) => e.id), ["e1"]);
  assert.ok(data.events[0].participants.includes("Участник Бета — Руководитель команды Б"));
  const serialized = JSON.stringify(data);
  for (const privateText of ["Личная встреча Беты", "Личная задача Беты", "Личная цель Беты", "PRIVATE_B_SKILL_EVIDENCE"]) assert.equal(serialized.includes(privateText), false);
  assert.equal(data.peerReviews.length, 2, "received reviews and this manager's own reviews are available");
});

test("personal selection filters tasks, plans and skills without losing shared participants", () => {
  const data = prepareExportData(exportFixture(), { personId: "p1" }, generatedAt);
  assert.equal(data.people.length, 1);
  assert.equal(data.tasks.length, 2);
  assert.equal(data.skills.length, 1);
  assert.equal(data.attendance.length, 1);
  assert.ok(data.events[0].participants.includes("Участник Бета"));
  assert.ok(data.people[0].successCriteria.includes("три"));
});

test("selected event export excludes unrelated records and unlinked practice", () => {
  const data = prepareExportData(exportFixture(), { eventIds: ["e2"] }, generatedAt);
  assert.deepEqual(data.people.map((p) => p.id), ["p2"]);
  assert.equal(data.tasks.length, 1);
  assert.equal(data.events.length, 1);
  assert.equal(data.peerReviews.length, 0);
  assert.equal(data.attendance[0].status, "Не отмечено");
  const empty = prepareExportData(exportFixture(), { eventIds: [] }, generatedAt);
  assert.equal(empty.events.length + empty.people.length + empty.tasks.length, 0);
});

test("pending access and unavailable selections fail instead of widening the export", () => {
  const workspace = exportFixture();
  workspace.role = "pending";
  assert.throws(() => prepareExportData(workspace), /после входа/);
  workspace.role = "manager";
  workspace.user.id = "PRIVATE_USER_A";
  assert.throws(() => prepareExportData(workspace, { personId: "p2" }), /недоступен/);
  assert.throws(() => prepareExportData(workspace, { eventIds: ["e2"] }), /недоступно/);
  assert.throws(() => prepareExportData(exportFixture(), { eventIds: ["missing"] }), /недоступно/);
});

test("historical peer feedback survives archived events and roster changes with safe display fallbacks", () => {
  const workspace = exportFixture();
  workspace.role = "manager";
  workspace.user.id = "PRIVATE_USER_A";
  workspace.people = [workspace.people[0]];
  workspace.peerReviews.push(Object.assign({ id: "historical", eventId: "e3", personId: "p1", reviewerPersonId: "former", score: 3, comment: "Исторический отзыв", updatedAt: "2026-10-10T12:00:00Z" }, { personName: "Участник Альфа", reviewerName: "Бывший участник", eventTitle: "Прошедшая встреча" }));
  const complete = prepareExportData(workspace, { personId: "p1" }, generatedAt);
  const history = complete.peerReviews.find((review) => review.comment === "Исторический отзыв");
  assert.ok(history);
  assert.equal(history.reviewer, "Бывший участник");
  assert.equal(history.event, "Прошедшая встреча");
  const filtered = prepareExportData(workspace, { eventIds: ["e1"] }, generatedAt);
  assert.equal(filtered.peerReviews.some((review) => review.comment === "Исторический отзыв"), false);
});

test("timestamp dates in export follow Moscow while date-only deadlines remain unchanged", () => {
  const workspace = exportFixture();
  workspace.tasks[0].completedAt = "2026-10-30T22:30:00Z";
  const sheet = exportSheets(prepareExportData(workspace, {}, generatedAt)).find((item) => item.name === "Практические задачи")!;
  assert.equal((sheet.rows[0][7] as Date).toISOString().slice(0, 10), "2026-10-31");
  assert.equal((sheet.rows[0][4] as Date).toISOString().slice(0, 10), "2026-10-30");
});

test("seven readable sheets preserve absent ratings as null and actual zero as zero", () => {
  const sheets = exportSheets(prepareExportData(exportFixture(), {}, generatedAt));
  assert.deepEqual(sheets.map((s) => s.name), ["Участники", "Мероприятия", "ИПР", "Практические задачи", "Навыки", "Посещение", "Оценки коллег"]);
  const skills = sheets.find((s) => s.name === "Навыки")!;
  assert.equal(skills.rows[0][2], null);
  assert.equal(skills.rows[1][2], 0);
  const tasks = sheets.find((s) => s.name === "Практические задачи")!;
  assert.equal(tasks.rows[0][8], null);
  assert.equal(tasks.rows[1][8], 4);
  assert.ok(tasks.rows[0][4] instanceof Date);
});

test("XLSX is an OOXML workbook with seven sheets and formula-looking text stays text", async () => {
  const entries = zipEntries(await buildXlsx(prepareExportData(exportFixture(), {}, generatedAt)));
  const workbook = entries.get("xl/workbook.xml")!;
  assert.equal((workbook.match(/<sheet /g) ?? []).length, 7);
  assert.ok(workbook.includes("Оценки коллег"));
  assert.ok(entries.get("xl/sharedStrings.xml")?.includes("=HYPERLINK"));
  for (const [path, xml] of entries) if (/xl\/worksheets\//.test(path)) assert.equal(/<f[ >]/.test(xml), false, path);
  const taskXml = entries.get("xl/worksheets/sheet4.xml")!;
  assert.ok(/<c r="B5"[^>]*t="s"/.test(taskXml), "formula prefix is a shared string");
  assert.equal(/<c r="I5"[^>]*>\s*<v>0<\/v>/.test(taskXml), false, "missing task rating is not zero");
});

test("DOCX contains readable personal IPR, outcomes and repeating table headers, with no private fields", async () => {
  const entries = zipEntries(await buildDocx(prepareExportData(exportFixture(), { personId: "p1" }, generatedAt)));
  const xml = entries.get("word/document.xml")!;
  for (const expected of ["Индивидуальный план развития", "Руководитель команды А", "Развить навык обратной связи", "Провести три развивающие беседы", "Практические действия", "Обратная связь коллег", "Участник Бета"]) assert.ok(xml.includes(expected), expected);
  assert.ok(xml.includes("w:tblHeader"));
  assert.ok(xml.includes("w:tblLayout w:type=\"fixed\""));
  const allXml = [...entries.values()].join("\n");
  for (const forbidden of ["PRIVATE_ADMIN", "PRIVATE_USER", "PRIVATE_AUDIT", "PRIVATE_B_SKILL_EVIDENCE", "Личная цель Беты", "PRIVATE_RATER"]) assert.equal(allXml.includes(forbidden), false, forbidden);
});
