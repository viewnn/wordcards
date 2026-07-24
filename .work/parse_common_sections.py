import json
import re

pages = json.load(open("E:/WordCards1.2/.work/pdf_pages.json", encoding="utf-8"))

def lines_for(start, end):
    rows = []
    for page in pages[start - 1:end]:
        for line in page.splitlines():
            line = line.strip()
            if line and line != "202407 - 202602" and not line.isdigit():
                rows.append(line)
    return rows

def parse_parenthesized(start, end, category):
    rows = lines_for(start, end)
    entries = []
    current = None
    pattern = re.compile(r"^(\d+)\.(.+?)：\s*(.*?)（(.*)）$")
    for line in rows:
        match = pattern.match(line)
        if match:
            if current:
                entries.append(current)
            current = {
                "word": match.group(2).strip(),
                "phonetic": match.group(3).strip(),
                "meaning": match.group(4).strip(),
                "exampleLines": [],
                "category": category,
            }
        elif re.match(r"^8\.\d+\.", line):
            if current:
                entries.append(current)
                current = None
        elif current:
            current["exampleLines"].append(line)
    if current:
        entries.append(current)
    for entry in entries:
        entry["example"] = "；".join(entry.pop("exampleLines"))
    return entries

short = parse_parenthesized(56, 80, "常用语")
print("COMMON_SHORT", len(short))
for entry in short[:3] + short[-3:]:
    print(entry)

header_pattern = re.compile(r"^\d+\.")
valid_pattern = re.compile(r"^\d+\.(.+?)：\s*(.*?)（(.*)）$")
for line in lines_for(56, 80):
    if header_pattern.match(line) and not valid_pattern.match(line):
        print("UNMATCHED", line)
numbers = [int(re.match(r"^(\d+)\.", line).group(1)) for line in lines_for(56, 80) if valid_pattern.match(line)]
print("MISSING_NUMBERS", [number for number in range(1, 235) if number not in numbers])

def parse_common_vocabulary():
    rows = lines_for(35, 46)
    categories = {
        "8.1.": "否定词", "8.2.": "进行完成", "8.3.": "程度词", "8.4.": "特殊词",
        "8.5.": "副词-特殊", "8.6.": "语气助词", "8.7.": "情绪环境",
    }
    entries, current, category = [], None, None
    pattern = re.compile(r"^\d+\.(.+?)：\s*(.*?)（(.*)）$")
    for line in rows:
        matched_category = next((value for prefix, value in categories.items() if line.startswith(prefix)), None)
        if matched_category:
            if current:
                entries.append(current)
                current = None
            category = matched_category
            continue
        if line.startswith("8.8.") or line.startswith("8.9."):
            if current:
                entries.append(current)
                current = None
            category = None
            continue
        match = pattern.match(line)
        if category and match:
            if current:
                entries.append(current)
            current = {"word": match.group(1).strip(), "phonetic": match.group(2).strip(), "meaning": match.group(3).strip(), "exampleLines": [], "category": category}
        elif current:
            current["exampleLines"].append(line)
    if current:
        entries.append(current)
    for entry in entries:
        entry["example"] = "；".join(entry.pop("exampleLines"))
    return entries

vocabulary = parse_common_vocabulary()
print("VOCAB", len(vocabulary))
for entry in vocabulary[:2] + vocabulary[-2:]:
    print(entry)

json.dump({"commonShort": short, "vocabulary": vocabulary}, open("E:/WordCards1.2/.work/parsed_common.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
