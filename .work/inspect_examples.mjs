import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("E:/WordCards1.2/dict.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("phrase2");
const rows = sheet.getRange("A2:F1841").values;
const grouped = new Map();
for (const [word, meaning, phonetic, example, category, language] of rows) {
  const key = String(category ?? "");
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push({ word, meaning, phonetic, example, language });
}
for (const [category, items] of grouped) {
  console.log(`${category}\t${items.length}\tempty=${items.filter(x => !x.example).length}`);
}
