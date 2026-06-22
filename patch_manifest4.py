import json, sys
# Usage: python patch_manifest4.py <path/to/manifest.json>

from batch_filter import create_batch_filter

is_excluded = create_batch_filter(
    prefixes=['lib/db/migrations/meta/'],
    exact_names={'.DS_Store'},
)

manifest_path = sys.argv[1]

with open(manifest_path) as f:
    m = json.load(f)

newly_skipped = 0
for file in m['files']:
    if file.get('skipped'):
        continue
    if is_excluded(file['path']):
        file['skipped'] = True
        file['skip_reason'] = 'excluded_dir'
        newly_skipped += 1

batches = m['batches']['index']
new_batches = []
removed = 0
shrunk = 0
for b in batches:
    if b['status'] == 'completed':
        new_batches.append(b)
        continue
    kept = [f for f in b['files'] if not is_excluded(f)]
    if not kept:
        removed += 1
        continue
    if len(kept) < len(b['files']):
        b['files'] = kept
        shrunk += 1
    new_batches.append(b)

m['batches']['index'] = new_batches

statuses = {}
for b in new_batches:
    statuses[b['status']] = statuses.get(b['status'], 0) + 1

print(f'Files newly skipped: {newly_skipped}')
print(f'Batches removed: {removed}')
print(f'Batches shrunk: {shrunk}')
print(f'Final statuses: {statuses}')

with open(manifest_path, 'w') as f:
    json.dump(m, f, indent=2)
print('Done.')
