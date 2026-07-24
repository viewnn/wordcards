import json
from pypdf import PdfReader

reader = PdfReader("E:/WordCards1.2/dict.pdf")
pages = [(page.extract_text() or "").encode("utf-8", "surrogatepass").decode("utf-8", "replace") for page in reader.pages]
with open("E:/WordCards1.2/.work/pdf_pages.json", "w", encoding="utf-8") as output:
    json.dump(pages, output, ensure_ascii=False, indent=2)
print(f"Extracted {len(pages)} pages")
