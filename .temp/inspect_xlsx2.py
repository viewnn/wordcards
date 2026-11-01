import zipfile, re

z = zipfile.ZipFile(r"E:\repository\WordCards4.3\.temp\site-noeng5k\dict.xlsx")
print("worksheets:", [n for n in z.namelist() if n.startswith('xl/worksheets')])

for sheet, tag in [("xl/worksheets/sheet1.xml", "Can短语"), ("xl/worksheets/sheet2.xml", "Can字")]:
    xml = z.read(sheet).decode('utf-8')
    print(f"\n===== {tag} ({sheet}) size={len(xml)} =====")
    # 头部 500 字（dimension/sheetViews 等）
    print("--- head ---")
    print(xml[:600])
    # 表头行
    m = re.search(r'<row [^>]*r="1"[^>]*>.*?</row>', xml)
    print("--- row 1 (header) ---")
    print(m.group(0)[:800] if m else 'no row 1')
    # 第一条数据行
    m2 = re.search(r'<row [^>]*r="2"[^>]*>.*?</row>', xml)
    print("--- row 2 (first data) ---")
    print(m2.group(0)[:1200] if m2 else 'no row 2')
    # 统计单元格类型
    print("cell types:", {t: len(re.findall(f'<c [^>]*t="{t}"', xml)) for t in ['s', 'inlineStr', 'str'] if re.findall(f'<c [^>]*t="{t}"', xml)})

# 有没有 sharedStrings？
names = z.namelist()
print("\nhas sharedStrings.xml:", any('sharedStrings' in n for n in names))
print("all entries:", names)
