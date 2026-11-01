import sys, zipfile, re
sys.path.insert(0, r"E:\repository\WordCards4.3\.temp\pylibs")
import openpyxl

# 1) 打开工作簿拿 sheet -> xml 文件名映射
wb = openpyxl.load_workbook(r"E:\repository\WordCards4.3\.temp\site-noeng5k\dict.xlsx")
# internal sheet order: wb.sheetnames -> xl/worksheets/sheetN.xml 按 workbook.xml 顺序
names = wb.sheetnames
wb.close()
print("sheet order:", names)

z = zipfile.ZipFile(r"E:\repository\WordCards4.3\.temp\site-noeng5k\dict.xlsx")
print([n for n in z.namelist() if not n.startswith('xl/worksheets')])
# workbook.xml 里 sheet 名与 rId 的对应
wbxml = z.read('xl/workbook.xml').decode('utf-8')
print("--- workbook.xml sheets ---")
print(re.findall(r'<sheet [^>]+>', wbxml))
rels = z.read('xl/_rels/workbook.xml.rels').decode('utf-8')
print("--- rels ---")
print(rels[:2000])
