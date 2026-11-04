import zipfile, re
p = r"E:\repository\WordCards4.3\dict.xlsx"
z = zipfile.ZipFile(p)
xml = z.read('xl/workbook.xml').decode('utf-8')
sheets = re.findall(r'<sheet [^>]*name="([^"]+)"', xml)
print("sheets:", [s for s in sheets if not s.startswith('_xlnm')])
