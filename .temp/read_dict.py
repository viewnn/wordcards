import sys
sys.path.insert(0, r"E:\repository\WordCards4.3\.temp\pylibs")
import openpyxl
wb = openpyxl.load_workbook(r"E:\repository\WordCards4.3\dict.xlsx", read_only=True, data_only=True)
for ws in wb.worksheets:
    rows = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        rows.append(row)
        if i >= 2:
            break
    print(f"=== sheet: {ws.title!r}  (rows~{ws.max_row}, cols~{ws.max_column})")
    for r in rows:
        print("   ", [str(c)[:18] if c is not None else "" for c in r])
wb.close()
