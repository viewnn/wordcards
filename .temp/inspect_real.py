import zipfile, re

# 检查真词典当前版本的内部结构
z = zipfile.ZipFile(r"E:\repository\WordCards4.3\dict.xlsx")
names = z.namelist()
print("entries:", [n for n in names if 'workbook.xml' in n or 'sharedStrings' in n or n.startswith('xl/worksheets')])
wbxml = z.read('xl/workbook.xml').decode('utf-8')
print("sheets:", re.findall(r'name="([^"]+)"', wbxml)[:6])

has_ss = any('sharedStrings' in n for n in names)
print("has sharedStrings.xml:", has_ss)

# 找 Can字 的 sheet 文件
rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8')
rels_map = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
sheet_ids = re.findall(r'<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"', wbxml)
for nm, rid in sheet_ids:
    target = rels_map.get(rid, '?')
    # Target 可能是 /xl/worksheets/... 或 worksheets/...
    path = target.lstrip('/')
    if not path.startswith('xl/'):
        path = 'xl/' + target
    try:
        xml = z.read(path).decode('utf-8')
    except KeyError:
        print(f"  {nm}: cannot read {path}")
        continue
    dim = re.search(r'<dimension ref="[^"]+"', xml)
    # 公式单元格 / 公式但缓存值非空 / inlineStr 数量
    f_all = len(re.findall(r'<f[ >]', xml))
    f_empty = len(re.findall(r'<f[^>]*>[^<]*</f><v></v>', xml))
    f_cached = len(re.findall(r'<f[^>]*>[^<]*</f><v>[^<]+</v>', xml))
    inline = len(re.findall(r't="inlineStr"', xml))
    shared = len(re.findall(r't="s"', xml))
    print(f"  {nm}: {path} dim={dim.group(0) if dim else '?'} formulas={f_all} (cached={f_cached}, emptycache={f_empty}) inlineStr={inline} shared={shared}")
