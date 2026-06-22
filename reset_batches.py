import json, os

RESET_IDS = {
    'batch-228', 'batch-255', 'batch-269', 'batch-364',
    'batch-365', 'batch-366', 'batch-374', 'batch-383', 'batch-384',
}

manifest_path = 'C:/Users/cflur/projects/voyagedesk/code-analysis/manifest.json'
index_dir = 'C:/Users/cflur/projects/voyagedesk/code-analysis/index'

with open(manifest_path) as f:
    m = json.load(f)

for b in m['batches']['index']:
    if b['id'] in RESET_IDS:
        print(f"Resetting {b['id']}: {b['files']}")
        b['status'] = 'pending'
        b['attempts'] = 0
        b['completed_at'] = None
        output = os.path.join(index_dir, f"{b['id']}.json")
        if os.path.exists(output):
            os.remove(output)
            print(f"  Deleted {output}")

with open(manifest_path, 'w') as f:
    json.dump(m, f, indent=2)

statuses = {}
for b in m['batches']['index']:
    statuses[b['status']] = statuses.get(b['status'], 0) + 1
print(f'Done. Statuses: {statuses}')
