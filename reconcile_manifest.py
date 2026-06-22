import json, os

manifest_path = 'C:/Users/cflur/projects/voyagedesk/code-analysis/manifest.json'
index_dir = 'C:/Users/cflur/projects/voyagedesk/code-analysis/index'

# Ground truth: which batches have output files on disk
completed_on_disk = {
    f.replace('.json', '')
    for f in os.listdir(index_dir)
    if f.endswith('.json')
}
print(f'Output files on disk: {len(completed_on_disk)}')

with open(manifest_path) as f:
    m = json.load(f)

batches = m['batches']['index']
fixed_completed = 0
fixed_to_pending = 0
already_correct = 0

for b in batches:
    bid = b['id']
    if bid in completed_on_disk:
        if b['status'] != 'completed':
            b['status'] = 'completed'
            b['completed_at'] = b.get('completed_at') or 'reconciled'
            fixed_completed += 1
        else:
            already_correct += 1
    else:
        # No output file — reset to pending so it retries
        if b['status'] in ('failed', 'completed'):
            b['status'] = 'pending'
            b['attempts'] = 0
            b['completed_at'] = None
            fixed_to_pending += 1

statuses = {}
for b in batches:
    statuses[b['status']] = statuses.get(b['status'], 0) + 1

print(f'Fixed to completed: {fixed_completed}')
print(f'Already completed: {already_correct}')
print(f'Reset to pending (no output): {fixed_to_pending}')
print(f'Final statuses: {statuses}')

with open(manifest_path, 'w') as f:
    json.dump(m, f, indent=2)
print('Manifest reconciled.')
