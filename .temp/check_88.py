import sys
sys.path.insert(0, r"E:\repository\WordCards4.3\.temp\pylibs")
import openpyxl

# 用 data_only=True 读真词典（Excel 保存版，公式缓存值可读）
wb = openpyxl.load_workbook(r"E:\repository\WordCards4.3\dict.xlsx", data_only=True)
print("sheets:", wb.sheetnames)
ws = wb["88"]
rows = list(ws.iter_rows(values_only=True))
print("88 header:", rows[0])
for r in rows[1:4]:
    print("  row:", [str(c)[:20] if c is not None else None for c in r])
print("88 data rows:", len(rows) - 1)

# Can字 sheet 用 data_only 读公式列（音标列 D 的缓存值）
ws2 = wb["Can字"]
rows2 = list(ws2.iter_rows(values_only=True))
print("\nCan字 header:", rows2[0])
ok = bad = 0
for r in rows2[1:]:
    ph = r[3] if len(r) > 3 else None
    if ph is not None and str(ph).strip():
        ok += 1
    else:
        bad += 1
print(f"Can字 phonetic(data_only): ok={ok} empty={bad}")
for r in rows2[1:4]:
    print("  row:", [str(c)[:18] if c is not None else None for c in r[:6]])

# Can短语 sanity
ws3 = wb["Can短语"]
r3 = list(ws3.iter_rows(values_only=True))
print("\nCan短语 first row:", [str(c)[:16] if c is not None else None for c in r3[1][:6]], "total:", len(r3)-1)
wb.close()
