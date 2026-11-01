import sys
sys.path.insert(0, r"E:\repository\WordCards4.3\.temp\pylibs")
import openpyxl
from collections import OrderedDict
wb = openpyxl.load_workbook(r"E:\repository\WordCards4.3\dict.xlsx", read_only=True, data_only=True)
for ws in wb.worksheets:
    types = OrderedDict()
    head = None
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            head = [str(c) if c is not None else "" for c in row]
            print(f"sheet={ws.title!r} header={head}")
            if "类型" not in head:
                print("  (no 类型 column)")
                break
            ti = head.index("类型")
            continue
        v = row[ti] if ti < len(row) else None
        v = str(v).strip() if v is not None else ""
        if v:
            types[v] = types.get(v, 0) + 1
    else:
        print(f"  类型列去重值({len(types)}): " + "、".join(f"{k}({n})" for k, n in types.items()))
wb.close()
