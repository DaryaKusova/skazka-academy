import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

const { prepareExportData, exportSheets, buildXlsx, buildDocx } = await import(new URL("../lib/exports.ts", import.meta.url).href) as typeof import("../lib/exports");
const { exportFixture, detailedExportFixture } = await import(new URL("./fixtures/export-workspace.ts", import.meta.url).href) as typeof import("./fixtures/export-workspace");
const { PLAN_SECTIONS, emptyPlanDetails } = await import(new URL("../lib/development-plan.ts", import.meta.url).href) as typeof import("../lib/development-plan");
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

test("detailed IPR export projects all six sections, period and sources without other people's plans", () => {
  const workspace = detailedExportFixture();
  workspace.role = "manager";
  workspace.user.id = "PRIVATE_USER_A";
  Object.assign(workspace.developmentPlans[0].details!, { futureSecret: "UNEXPECTED_DETAIL_SECRET" });
  const data = prepareExportData(workspace, {}, generatedAt);
  const details = data.people[0].details!;
  assert.equal(details.periodStart, "2026-11-01");
  assert.equal(details.periodEnd, "2027-04-30");
  assert.equal(details.sourceNote, workspace.developmentPlans[0].details!.sourceNote);
  for (const { key } of PLAN_SECTIONS) assert.deepEqual(details.sections[key], workspace.developmentPlans[0].details!.sections[key]);
  const json = JSON.stringify(data);
  for (const forbidden of ["PRIVATE_B_PLAN_SOURCE", "PRIVATE_B_PLAN_DETAILS", "PRIVATE_B_DIAGNOSTIC", "UNEXPECTED_DETAIL_SECRET"]) assert.equal(json.includes(forbidden), false, forbidden);
  details.sections.priorities[0].cells[0] = "Измененная копия";
  assert.notEqual(workspace.developmentPlans[0].details!.sections.priorities[0].cells[0], "Измененная копия", "export projection does not mutate live plan data");
});

test("detailed IPR sheets preserve full columns and separate diagnostic 0–10 scores", () => {
  const data = prepareExportData(detailedExportFixture(), { personId: "p1" }, generatedAt);
  const sheets = exportSheets(data);
  assert.equal(sheets.length, 14);
  const plan = sheets.find((sheet) => sheet.name === "ИПР")!;
  assert.equal((plan.rows[0][6] as Date).toISOString().slice(0, 10), "2026-11-01");
  assert.equal(plan.rows[0][8], data.people[0].details!.sourceNote);
  assert.equal(plan.rows[0][9], "Учебная анкета самооценки");
  assert.equal(plan.rows[0][10], "Учебная внешняя оценка");
  for (const section of PLAN_SECTIONS) {
    const sheet = sheets.find((item) => item.title === section.title)!;
    assert.ok(sheet);
    assert.deepEqual(sheet.columns.slice(2).map(([header]) => header), [...section.columns]);
    assert.deepEqual(sheet.rows.map((row) => row.slice(2)), data.people[0].details!.sections[section.key].map((row) => row.cells));
  }
  const diagnostics = sheets.find((sheet) => sheet.name === "ИПР Диагностика")!;
  assert.equal(diagnostics.rows[0][3], 7);
  assert.equal(diagnostics.rows[0][4], null);
  assert.equal(diagnostics.rows[1][3], 0);
  assert.equal(diagnostics.rows[1][4], 9);
  assert.ok(diagnostics.columns[3][0].includes("0–10"));
  assert.ok(sheets.find((sheet) => sheet.name === "Навыки")!.columns[2][0].includes("0–5"));
  assert.ok(sheets.find((sheet) => sheet.name === "Практические задачи")!.columns[8][0].includes("1–5"));
});

test("empty detailed IPR retains reusable section headers and blank diagnostic scores", () => {
  const workspace = exportFixture();
  workspace.developmentPlans[0].details = emptyPlanDetails();
  const sheets = exportSheets(prepareExportData(workspace, { personId: "p1" }, generatedAt));
  assert.equal(sheets.length, 13);
  const diagnostics = sheets.find((sheet) => sheet.name === "ИПР Диагностика")!;
  assert.deepEqual(diagnostics.rows[0].slice(2), ["", null, ""]);
  assert.equal(sheets.some((sheet) => sheet.name === "ИПР Контекст"), false);
  for (const section of PLAN_SECTIONS.filter((section) => section.key !== "selfContext")) assert.deepEqual(sheets.find((sheet) => sheet.title === section.title)!.rows[0].slice(2), ["", "", "", "", ""]);
});

test("detailed XLSX stores all plan text and literal formula prefixes without altering null or zero diagnostics", async () => {
  const data = prepareExportData(detailedExportFixture(), { personId: "p1" }, generatedAt);
  const entries = zipEntries(await buildXlsx(data));
  assert.equal((entries.get("xl/workbook.xml")!.match(/<sheet /g) ?? []).length, 14);
  const strings = entries.get("xl/sharedStrings.xml")!;
  for (const expected of ["=SUM(1,2)", "+Текст", "-Текст", "@Текст", "Конец подробного описания", "Учебная анкета самооценки", "Учебная внешняя оценка"]) assert.ok(strings.includes(expected), expected);
  for (const [path, xml] of entries) if (/xl\/worksheets\//.test(path)) assert.equal(/<f[ >]/.test(xml), false, path);
  const diagnosticXml = entries.get("xl/worksheets/sheet8.xml")!;
  assert.ok(/<c r="D6"[^>]*><v>0<\/v><\/c>/.test(diagnosticXml));
  assert.equal(/<c r="E5"[^>]*><v>0<\/v><\/c>/.test(diagnosticXml), false);
  assert.equal(strings.includes("PRIVATE_B_PLAN_DETAILS"), false);
});

test("detailed DOCX includes complete IPR sources, diagnostics and every five-column section", async () => {
  const data = prepareExportData(detailedExportFixture(), { personId: "p1" }, generatedAt);
  const entries = zipEntries(await buildDocx(data));
  const xml = entries.get("word/document.xml")!;
  for (const expected of ["01.11.2026", "30.04.2027", "Анонимный учебный пример ИПР", "Дополнительное основание", "Учебная анкета самооценки", "Учебная внешняя оценка", "Диагностика компетенций ИПР", "Самооценка 0–10", "Внешняя оценка 0–10", "Конец подробного описания", "Исходное значение ноль"]) assert.ok(xml.includes(expected), expected);
  for (const section of PLAN_SECTIONS) {
    assert.ok(xml.includes(section.title));
    for (const cell of data.people[0].details!.sections[section.key][0].cells) assert.ok(xml.includes(cell), cell);
  }
  assert.equal((xml.match(/<w:tbl>/g) ?? []).length, 11, "six detailed sections plus diagnostics and four existing tables");
  for (const forbidden of ["PRIVATE_B_PLAN_SOURCE", "PRIVATE_B_PLAN_DETAILS", "PRIVATE_B_DIAGNOSTIC"]) assert.equal(xml.includes(forbidden), false, forbidden);
});

test("self-assessment-only export omits external evaluation, empty responses and empty context in XLSX and DOCX", async () => {
  const workspace = detailedExportFixture();
  const details = workspace.developmentPlans[0].details!;
  details.externalAssessmentSource = "   ";
  details.diagnostics = details.diagnostics.map((entry) => ({ ...entry, externalScore: null, planResponse: " " }));
  details.sections.selfContext = [{ id: "blank-context", cells: ["", " ", "", "", ""] }];
  const data = prepareExportData(workspace, { personId: "p1" }, generatedAt);
  const sheets = exportSheets(data);
  assert.equal(sheets.length, 13);
  const diagnostics = sheets.find((sheet) => sheet.name === "ИПР Диагностика")!;
  assert.deepEqual(diagnostics.columns.map(([label]) => label), ["ФИО", "Должность", "Компетенция", "Самооценка 0–10", "Комментарий сотрудника"]);
  assert.equal(diagnostics.rows[1][3], 0);
  const [xlsx, docx] = await Promise.all([buildXlsx(data), buildDocx(data)]);
  const xlsxEntries = zipEntries(xlsx), docxEntries = zipEntries(docx);
  const worksheetText = xlsxEntries.get("xl/sharedStrings.xml")!;
  const wordText = docxEntries.get("word/document.xml")!;
  for (const text of [worksheetText, wordText]) {
    assert.equal(/CEO|внешн|Ответ в плане развития|Сильные стороны и контекст самооценки/i.test(text), false);
    assert.ok(text.includes("Самооценка 0–10"));
    for (const section of PLAN_SECTIONS.filter((section) => section.key !== "selfContext")) assert.ok(text.includes(section.title));
  }
  assert.equal((wordText.match(/<w:tbl>/g) ?? []).length, 10);
  assert.equal(xlsxEntries.get("xl/workbook.xml")!.includes("ИПР Контекст"), false);
});

test("external diagnostic column is retained for a source alone or an actual zero score", async () => {
  for (const mode of ["source", "zero"] as const) {
    const workspace = detailedExportFixture();
    const details = workspace.developmentPlans[0].details!;
    details.externalAssessmentSource = mode === "source" ? "Учебный источник оценки" : "";
    details.diagnostics = [{ ...details.diagnostics[0], externalScore: mode === "zero" ? 0 : null, planResponse: "" }];
    const data = prepareExportData(workspace, { personId: "p1" }, generatedAt);
    const diagnostics = exportSheets(data).find((sheet) => sheet.name === "ИПР Диагностика")!;
    assert.ok(diagnostics.columns.some(([label]) => label === "Внешняя оценка 0–10"));
    assert.equal(diagnostics.rows[0][4], mode === "zero" ? 0 : null);
    assert.equal(diagnostics.columns.some(([label]) => label === "Ответ в плане развития"), false);
    const xml = zipEntries(await buildDocx(data)).get("word/document.xml")!;
    assert.ok(xml.includes("Внешняя оценка 0–10"));
    assert.equal(xml.includes("Ответ в плане развития"), false);
  }
});
