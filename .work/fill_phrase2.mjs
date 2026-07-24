import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "E:/WordCards1.2/dict.xlsx";
const outputDir = "E:/WordCards1.2/outputs/dict_phrase2_filled";
const outputPath = `${outputDir}/dict.xlsx`;

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const source = workbook.worksheets.getItem("phrase");
const target = workbook.worksheets.getItem("phrase2");
const sourceRange = source.getUsedRange();

if (sourceRange.address !== "A1:F1841") {
  throw new Error(`Unexpected phrase range: ${sourceRange.address}`);
}

target.getRange("A1:F1841").copyFrom(sourceRange, "all");
const phrase2Table = target.tables.items[0];
if (phrase2Table) {
  phrase2Table.resize(target.getRange("A1:F1841"));
}

const check = await workbook.inspect({
  kind: "table",
  sheetId: "phrase2",
  range: "A1:F1841",
  tableMaxRows: 5,
  tableMaxCols: 6,
  maxChars: 3000,
});
console.log(check.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 20 },
  summary: "formula error scan",
});
console.log(errors.ndjson);

const preview = await workbook.render({
  sheetName: "phrase2",
  range: "A1:F25",
  scale: 1,
  format: "png",
});
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(`${outputDir}/phrase2-preview.png`, new Uint8Array(await preview.arrayBuffer()));

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(`SAVED ${outputPath}`);
