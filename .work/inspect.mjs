import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const input = await FileBlob.load("E:/WordCards1.2/dict.xlsx");
const workbook = await SpreadsheetFile.importXlsx(input);
const summary = await workbook.inspect({ kind: "workbook,sheet,table", maxChars: 12000, tableMaxRows: 12, tableMaxCols: 12, tableMaxCellChars: 120 });
console.log(summary.ndjson);
for (const name of ["phrase2"]) {
  const sheet = workbook.worksheets.getItem(name);
  const used = sheet.getUsedRange();
  console.log("USED", name, used.address);
  const region = await workbook.inspect({ kind: "region", sheetId: name, range: used.address, maxChars: 30000 });
  console.log(region.ndjson);
  const style = await workbook.inspect({ kind: "computedStyle", sheetId: name, range: "A1:H15", maxChars: 10000 });
  console.log(style.ndjson);
  const png = await workbook.render({sheetName:name, autoCrop:"all", scale:1, format:"png"});
  await fs.writeFile("E:/WordCards1.2/.work/phrase2-before.png", new Uint8Array(await png.arrayBuffer()));
}
