#!/usr/bin/env python3
"""Stage the public PWA without local recordings or development files."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '_site'
if OUT.is_symlink():
    raise SystemExit('Refusing to replace a symlink at _site')
if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir()
for name in ['index.html', 'manifest.webmanifest', 'sw.js', '.nojekyll']:
    shutil.copy2(ROOT / name, OUT / name)
extensions = {'.html', '.js', '.css', '.json', '.svg', '.png', '.webp', '.pdf'}
for directory in ['assets', 'quizzes']:
    for source in (ROOT / directory).rglob('*'):
        if not source.is_file() or source.suffix not in extensions or source.name == 'sources.json':
            continue
        target = OUT / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
assert not list(OUT.rglob('*.mp3'))
files = [p for p in OUT.rglob('*') if p.is_file()]
print(f'Public site: {len(files)} files, {sum(p.stat().st_size for p in files):,} bytes; no bundled MP3 recordings')
