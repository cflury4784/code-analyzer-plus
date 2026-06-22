import json, sys
# Usage: python list_dirs.py <path/to/manifest.json>
from collections import Counter

with open(sys.argv[1]) as f:
    m = json.load(f)

files = m['files']
dirs = Counter()
for f in files:
    if not f.get('skipped'):
        top = f['path'].replace('\\', '/').split('/')[0]
        dirs[top] += 1

print(f"{'Count':>6}  Directory")
print('-' * 40)
for d, cnt in dirs.most_common():
    print(f'{cnt:6d}  {d}')
