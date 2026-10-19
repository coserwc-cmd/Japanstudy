#!/usr/bin/env python3
"""Build the two official JLPT N3 workbooks from the downloaded source files.

Usage: python3 tools/build_official_bank.py --source /workspace/jlpt-n3-official
Requires PyMuPDF and Pillow. No OCR or generated replacement questions are used.
The page maps below were checked against every original question booklet page.
Question content remains in the original page images, including furigana and art.
"""

import argparse
import hashlib
import json
import math
import re
import shutil
import unicodedata
from pathlib import Path

import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
INDEX_URL = "https://www.jlpt.jp/cn/samples/sampleindex.html"
POLICY_URL = "https://www.jlpt.jp/cn/policy.html"
PDF_LABELS = {
    "N3V": "文字词汇原卷", "N3G": "语法原卷", "N3R": "阅读原卷",
    "N3L": "听力原卷", "N3answer": "官方答案", "N3sheet": "答题卡",
    "N3script": "听力原文",
}
EXPECTED = {
    2012: [
        "32231424" + "341223" + "243312321" + "14323" + "41411",
        "2243412344231" + "24213" + "34321" + "3334" + "341321" + "1442" + "23",
        "241232" + "314244" + "224" + "2321" + "31322132",
    ],
    2018: [
        "42132431" + "433214" + "24131324412" + "41312" + "32213",
        "2431423231241" + "24213" + "34132" + "3241" + "234341" + "4413" + "22",
        "231212" + "241134" + "342" + "1233" + "132113212",
    ],
}

# Ranges are inclusive, and page numbers are one-based PDF page indices.
VOCAB_MAP = {
    2012: [(1, 8, 1, [3]), (9, 14, 2, [4]), (15, 23, 3, [5]), (24, 28, 4, [6]), (29, 33, 5, [7])],
    2018: [(1, 8, 1, [3]), (9, 14, 2, [4]), (15, 25, 3, [5]), (26, 30, 4, [6]), (31, 35, 5, [7])],
}
GRAMMAR_MAP = {
    2012: [(1, 7, 1, [3]), (8, 13, 1, [4]), (14, 16, 2, [5]), (17, 18, 2, [6]), (19, 23, 3, [8, 9])],
    2018: [(1, 7, 1, [3]), (8, 12, 1, [4]), (13, 13, 1, [5]), (14, 16, 2, [6]), (17, 18, 2, [7]), (19, 23, 3, [8, 9])],
}
READING_MAP = {
    2012: [(24, 24, 4, [1]), (25, 25, 4, [2]), (26, 26, 4, [3]), (27, 27, 4, [4]), (28, 30, 5, [5, 6]), (31, 33, 5, [7, 8]), (34, 37, 6, [9, 10]), (38, 39, 7, [11, 12])],
    2018: [(24, 24, 4, [1]), (25, 25, 4, [2]), (26, 26, 4, [3]), (27, 27, 4, [4]), (28, 30, 5, [5, 6]), (31, 33, 5, [7]), (34, 37, 6, [9, 10]), (38, 39, 7, [11, 12])],
}
LISTENING_MAP = {
    2012: {
        1: [[4], [4], [5], [5], [6], [6]],
        2: [[8], [8], [9], [9], [10], [10]],
        3: [[11], [11], [11]],
        4: [[13], [13], [14], [14]],
        5: [[15]] * 8,
    },
    2018: {
        1: [[4], [5], [5], [6], [6], [7]],
        2: [[9], [9], [10], [10], [11], [11]],
        3: [[12], [12], [12]],
        4: [[14], [14], [15], [15]],
        5: [[16]] * 9,
    },
}
SCRIPT_GROUP_PAGES = {
    2012: {1: [1, 2, 3, 4], 2: [4, 5, 6, 7], 3: [7, 8, 9], 4: [9, 10], 5: [10, 11, 12]},
    2018: {1: [1, 2, 3, 4], 2: [4, 5, 6, 7, 8], 3: [8, 9, 10], 4: [10, 11], 5: [11, 12, 13]},
}
VOCAB_TOPICS = {1: "漢字読み", 2: "表記", 3: "文脈規定", 4: "言い換え類義", 5: "用法"}
WRITTEN_TOPICS = {1: "文の文法・文法形式", 2: "文の文法・文の組み立て", 3: "文章の文法", 4: "内容理解・短文", 5: "内容理解・中文", 6: "内容理解・長文", 7: "情報検索"}
LISTENING_TOPICS = {1: "課題理解", 2: "ポイント理解", 3: "概要理解", 4: "発話表現", 5: "即時応答"}


def parse_answer_key(path, year):
    """Pair table number rows with answer rows using the PDF's real text blocks.

    The 2018 PDF stores the lower listening table before the upper reading
    table in its text stream; sorting by y position is therefore essential.
    Examples (例) are deliberately removed, never included as scored items.
    """
    sections = [{}, {}, {}]
    section = -1
    group = None
    pending = None
    for page_index, page in enumerate(fitz.open(path), start=1):
        blocks = sorted(page.get_text("blocks"), key=lambda b: (round(b[1], 1), b[0]))
        for block in blocks:
            if not 40 < block[1] < 680:
                continue
            tokens = unicodedata.normalize("NFKC", block[4]).strip().splitlines()
            if not tokens:
                continue
            heading = re.fullmatch(r"問題\s*(\d)", tokens[0])
            if heading:
                group = int(heading[1])
                if group == 1:
                    section += 1
                assert 0 <= section < 3, (year, section, tokens)
                pending = tokens[1:]
            elif group is not None and all(re.fullmatch(r"\d+", t) for t in tokens):
                if pending is None:
                    pending = tokens
                else:
                    assert len(pending) == len(tokens), (year, pending, tokens)
                    for number, answer in zip(pending, tokens):
                        if number == "例":
                            continue
                        key = (group, int(number))
                        assert key not in sections[section]
                        assert answer in "1234"
                        sections[section][key] = {"answer": answer, "answerPage": page_index}
                    pending = None
    for index, result in enumerate(sections):
        actual = "".join(v["answer"] for v in result.values())
        assert actual == EXPECTED[year][index], (year, index, actual)
    return sections


def image_path(year, name, page):
    return f"assets/official/{year}/{name}-p{page:02}.webp"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/workspace/jlpt-n3-official"))
    parser.add_argument("--width", type=int, default=1600)
    parser.add_argument("--reuse-images", action="store_true", help="Reuse already rendered page images at the requested width")
    args = parser.parse_args()
    manifest = json.loads((args.source / "manifest.json").read_text())
    source_by_path = {item["path"]: item for item in manifest["files"]}
    output = ROOT / "assets" / "official"
    output.mkdir(parents=True, exist_ok=True)
    banks = []
    page_maps = {}

    for year in (2012, 2018):
        src = args.source / str(year)
        dest = output / str(year)
        dest.mkdir(parents=True, exist_ok=True)
        key = parse_answer_key(src / "N3answer.pdf", year)
        title = f"官方 N3 试题集 · {year}" + (" 第二集" if year == 2018 else "")
        selected_pages = {}
        resources = []
        for filename, label in [(f"{name}.pdf", label) for name, label in PDF_LABELS.items()] + [(f"N3Q{g}.mp3", f"听力问题 {g} 原版音频") for g in range(1, 6)]:
            data = source_by_path[f"{year}/{filename}"]
            original = src / filename
            assert hashlib.sha256(original.read_bytes()).hexdigest() == data["sha256"], original
            shutil.copyfile(original, dest / filename)
            resources.append({"label": label, "path": f"assets/official/{year}/{filename}", "sourceUrl": data["source_url"], "bytes": data["bytes"], "sha256": data["sha256"]})

        def images(name, pages):
            selected_pages.setdefault(name, set()).update(pages)
            return [image_path(year, name, p) for p in pages]

        def question(subject, name, group, number, pages, answer_section):
            answer = key[answer_section][(group, number)]
            q = {
                "id": f"official-{year}-{subject}-" + (f"{group}-" if subject == "listening" else "") + str(number),
                "kind": "choice", "level": "N3", "subject": subject,
                "prompt": f"请作答原卷「問題 {group}」第 {number} 题，题干和选项见下方原卷。",
                "options": ["1", "2", "3", "4"], "answer": answer["answer"],
                "explanation": f"官方答案为选项 {answer['answer']}。可展开官方答案表，对照本题题号复核。",
                "sourceLabel": title,
                "sourceUrl": source_by_path[f"{year}/{name}.pdf"]["source_url"],
                "officialNumber": f"問題 {group} · 第 {number} 题",
                "pageImages": images(name, pages),
                "answerImages": images("N3answer", [answer["answerPage"]]),
            }
            return q

        vocab = []
        for first, last, group, pages in VOCAB_MAP[year]:
            for number in range(first, last + 1):
                q = question("vocab", "N3V", group, number, pages, 0)
                q["topic"] = VOCAB_TOPICS[group]
                vocab.append(q)
        written = []
        for subject, name, mappings in [("grammar", "N3G", GRAMMAR_MAP[year]), ("reading", "N3R", READING_MAP[year])]:
            for first, last, group, pages in mappings:
                for number in range(first, last + 1):
                    q = question(subject, name, group, number, pages, 1)
                    q["topic"] = WRITTEN_TOPICS[group]
                    written.append(q)
        listening = []
        for group, page_lists in LISTENING_MAP[year].items():
            for number, pages in enumerate(page_lists, start=1):
                q = question("listening", "N3L", group, number, pages, 2)
                q["topic"] = LISTENING_TOPICS[group]
                q["audioSrc"] = f"assets/official/{year}/N3Q{group}.mp3"
                q["audioGroup"] = f"official-{year}-listening-{group}"
                q["audioLabel"] = f"问题 {group} 原版录音（整组，含说明和例题）"
                q["scriptImages"] = images("N3script", SCRIPT_GROUP_PAGES[year][group])
                q["explanation"] += f" 下方附问题 {group} 的官方听力原文，可对照录音复习。"
                if group in (4, 5):
                    q["options"] = ["1", "2", "3"]
                if group in (3, 5):
                    q["prompt"] = f"「問題 {group}」第 {number} 题：题干及选项均在录音中，原卷仅提供作答说明。请听录音选择答案。"
                elif group == 4:
                    q["prompt"] = f"「問題 4」第 {number} 题：请看原卷中对应题号的图片，听录音，从 1、2、3 中选择合适的表达。"
                else:
                    q["prompt"] = f"「問題 {group}」第 {number} 题：请看原卷中对应题号的选项，听录音选择答案。"
                assert q["answer"] in q["options"]
                listening.append(q)

        audio_duration = sum(item["duration_seconds"] for item in source_by_path.values() if item["volume_publication_year"] == year and item["path"].endswith(".mp3"))
        sections = [
            {"name": "文字・词汇", "minutes": 30, "questions": vocab},
            {"name": "语法・阅读", "minutes": 70, "questions": written},
            {"name": "听力", "minutes": math.ceil(audio_duration / 60), "questions": listening},
        ]
        bank = {
            "id": f"official-{year}", "year": year, "title": title,
            "source": {"name": "JLPT 官方公开试题集", "url": INDEX_URL},
            "official": True, "total": sum(len(s["questions"]) for s in sections),
            "audioDurationSeconds": audio_duration,
            "description": "题目选自 2010 年改革后的实际考试；年份为出版年份，不代表该年度某次完整考试。保留官方原卷、原版听力及答案。",
            "resources": resources, "sections": sections,
        }
        assert bank["total"] == (99 if year == 2012 else 102)
        banks.append(bank)
        page_maps[str(year)] = {name: sorted(pages) for name, pages in selected_pages.items()}

        for name, pages in selected_pages.items():
            document = fitz.open(src / f"{name}.pdf")
            for page_number in sorted(pages):
                target = ROOT / image_path(year, name, page_number)
                if args.reuse_images and target.exists():
                    with Image.open(target) as existing:
                        if existing.width in (args.width, args.width + 1):
                            continue
                page = document[page_number - 1]
                scale = args.width / page.rect.width
                pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                img = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                img.save(target, "WEBP", quality=88, method=6)

    (ROOT / "assets" / "official-banks.js").write_text(
        "// Generated by tools/build_official_bank.py from official JLPT sources.\n"
        "// Publication years identify the workbooks, not complete annual examinations.\n"
        "export const OFFICIAL_BANKS = " + json.dumps(banks, ensure_ascii=False, indent=2) + ";\n"
    )
    source_manifest = {
        "sourceIndex": INDEX_URL, "sitePolicy": POLICY_URL,
        "downloadedAt": manifest.get("downloaded_at"),
        "use": "免费教学使用的原卷图文注明官方来源，遵循官网使用规则第 1(4) 条；原版音频不随公开网站发布，仅从官网在线播放或由用户导入本机。",
        "note": "2012/2018 为出版年份，题目选自真实考试，并非相应年份某一考次的整卷。2012 问题2听力使用官网当前指定的 sample2017 文件。",
        "questionCounts": {str(bank["year"]): [len(s["questions"]) for s in bank["sections"]] for bank in banks},
        "files": manifest["files"], "renderedPdfPages": page_maps,
        "imageWidth": args.width, "imageFormat": "WebP quality 88",
    }
    (output / "sources.json").write_text(json.dumps(source_manifest, ensure_ascii=False, indent=2) + "\n")
    # README.md is maintained by hand so rebuilding cannot replace the current
    # publication and personal-audio instructions with stale licensing text.
    total_bytes = sum(p.stat().st_size for p in output.rglob("*") if p.is_file())
    print(json.dumps({"banks": [{"id": b["id"], "total": b["total"], "counts": [len(s["questions"]) for s in b["sections"]]} for b in banks], "assetBytes": total_bytes}, ensure_ascii=False))


if __name__ == "__main__":
    main()
