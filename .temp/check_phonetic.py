import sys
sys.path.insert(0, r"E:\repository\WordCards4.3\.temp\pylibs")
import openpyxl

paths = {
    "REAL": r"E:\repository\WordCards4.3\dict.xlsx",
    "COPY": r"E:\repository\WordCards4.3\.temp\site-noeng5k\dict.xlsx",
}
for tag, p in paths.items():
    wb = openpyxl.load_workbook(p, read_only=True)
    print(f"--- {tag} {p} sheets={wb.sheetnames}")
    if "Can字" not in wb.sheetnames:
        print("  no Can字 sheet!")
        continue
    ws = wb["Can字"]
    rows = ws.iter_rows(values_only=True)
    header = next(rows, None)
    print(f"  header={header}")
    total = 0; nonempty = 0; sample_empty = []
    # 音标列位置按表头找
    ph_idx = None
    if header:
        for i, h in enumerate(header):
            if h and str(h).strip() in ("音标", "jyutping"):
                ph_idx = i; break
    for r in rows:
        total += 1
        v = r[ph_idx] if ph_idx is not None and ph_idx < len(r) else None
        if v is not None and str(v).strip():
            nonempty += 1
        elif len(sample_empty) < 3:
            sample_empty.append(r[:6])
    print(f"  Can字 rows={total} phonetic_idx={ph_idx} nonempty={nonempty}")
    for s in sample_empty:
        print(f"  empty-phonetic row: {s}")
    wb.close()
