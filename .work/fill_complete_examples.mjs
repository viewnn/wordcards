import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "E:/WordCards1.2/dict.xlsx";
const outputDir = "E:/WordCards1.2/outputs/dict_phrase2_complete";
const outputPath = `${outputDir}/dict.xlsx`;
const pages = JSON.parse(await fs.readFile("E:/WordCards1.2/.work/pdf_pages.json", "utf8"));

function pageLines(startPage, endPage) {
  return pages.slice(startPage - 1, endPage).flatMap((page) => page.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line && !/^202407\s*-\s*202602$/.test(line) && !/^\d+$/.test(line));
}

function extractNumberedExamples(lines) {
  const found = new Map();
  let word = null;
  let exampleLines = [];
  const save = () => {
    if (word && exampleLines.length) found.set(word, exampleLines.join("；"));
  };
  for (const line of lines) {
    const match = line.match(/^\d+\.(.+?)：[^（]*（.*$/);
    if (match) {
      save();
      word = match[1].trim();
      exampleLines = [];
    } else if (/^\d+\.\d+\./.test(line)) {
      save();
      word = null;
      exampleLines = [];
    } else if (word) {
      exampleLines.push(line);
    }
  }
  save();
  return found;
}

// PDF pages 56-80 are the "常用短词" section; pages 35-46 contain numbered common-vocabulary entries.
const examples = new Map([
  ...extractNumberedExamples(pageLines(56, 80)),
  ...extractNumberedExamples(pageLines(35, 46)),
]);

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const source = workbook.worksheets.getItem("phrase");
const target = workbook.worksheets.getItem("phrase2");
const sourceRange = source.getUsedRange();
if (sourceRange.address !== "A1:F1841") throw new Error(`Unexpected phrase range: ${sourceRange.address}`);
target.getRange("A1:F1841").copyFrom(sourceRange, "all");

const words = target.getRange("A2:A1841").values;
const categories = target.getRange("E2:E1841").values;
const exampleCells = target.getRange("D2:D1841").values;
const eligibleCategories = new Set(["否定词", "进行完成", "程度词", "特殊词", "副词-特殊", "语气助词", "情绪环境", "俗语", "俚语", "常用短词"]);
let updated = 0;
let shortPhraseUpdated = 0;
for (let i = 0; i < words.length; i += 1) {
  const word = String(words[i][0] ?? "").trim();
  const category = String(categories[i][0] ?? "").trim();
  const fullExample = examples.get(word);
  if (eligibleCategories.has(category) && fullExample) {
    exampleCells[i][0] = fullExample;
    updated += 1;
    if (category === "常用短词") shortPhraseUpdated += 1;
  }
}
target.getRange("D2:D1841").values = exampleCells;
const table = target.tables.items[0];
if (table) table.resize(target.getRange("A1:F1841"));

const verification = await workbook.inspect({
  kind: "table",
  sheetId: "phrase2",
  range: "A1:F1841",
  tableMaxRows: 4,
  tableMaxCols: 6,
  maxChars: 2500,
});
console.log(verification.ndjson);
console.log(JSON.stringify({ extractedMappings: examples.size, updated, shortPhraseUpdated }));

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(`SAVED ${outputPath}`);
