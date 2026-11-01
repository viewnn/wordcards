# ⚠️ 警示：不要用 openpyxl 重存 dict.xlsx 来生成测试副本！
#   用户词典 Can字 sheet 的「类型/分类/音标/countif/count」列是公式列（如 音标=E2&"，"&F2），
#   openpyxl 重存会丢弃全部公式缓存值（<v></v> 变空），SheetJS 读到的音标就是空字符串，
#   应用导入后 3767 个字的音标全部丢失、练习分母从 5772 掉到 2010（2026-11-01 实际踩坑）。
#   正确做法：字节级复制（Copy-Item dict.xlsx 到副本路径）生成测试词典。
import sys
sys.path.insert(0, r"E:\repository\WordCards4.3\.temp\pylibs")
import openpyxl
wb = openpyxl.load_workbook(r"E:\repository\WordCards4.3\dict.xlsx")
if "Eng5k" in wb.sheetnames:
    del wb["Eng5k"]
wb.save(r"E:\repository\WordCards4.3\.temp\site-noeng5k\dict.xlsx")
print("sheets:", wb.sheetnames)
