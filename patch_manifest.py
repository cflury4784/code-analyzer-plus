import json, os, sys

EXCLUDED_DIRS = {
    'node_modules', '.git', '.worktrees', 'dist', 'build', 'out', 'coverage', 'code-analysis',
    '.next', '.nuxt', '.turbo', '.cache', '__pycache__', '.venv', 'venv',
    '.svelte-kit', '.parcel-cache', 'tmp', 'temp',
}
EXCLUDED_EXTS = {
    '.lock', '.snap', '.map', '.min.js', '.min.css',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
    '.svg', '.pdf', '.ai', '.psd', '.sketch',
    '.otf', '.ttf', '.woff', '.woff2', '.eot',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib',
}

def is_excluded(path):
    parts = path.replace('\\', '/').split('/')
    if parts[0] in EXCLUDED_DIRS:
        return 'excluded_dir'
    name = parts[-1].lower()
    for ext in EXCLUDED_EXTS:
        if name.endswith(ext):
            return 'excluded_extension'
    return None

manifest_path = sys.argv[1]
with open(manifest_path) as f:
    m = json.load(f)

# Update files array
newly_skipped = 0
for file in m['files']:
    if file.get('skipped'):
        continue
    reason = is_excluded(file['path'])
    if reason:
        file['skipped'] = True
        file['skip_reason'] = reason
        newly_skipped += 1

# Update pending batches
batches = m['batches']['index']
new_batches = []
removed_batches = 0
shrunk_batches = 0
for b in batches:
    if b['status'] == 'completed':
        new_batches.append(b)
        continue
    kept = [f for f in b['files'] if not is_excluded(f)]
    if not kept:
        removed_batches += 1
        continue
    if len(kept) < len(b['files']):
        b['files'] = kept
        shrunk_batches += 1
    new_batches.append(b)

m['batches']['index'] = new_batches

print(f'Files newly skipped: {newly_skipped}')
print(f'Batches removed (all-excluded): {removed_batches}')
print(f'Batches shrunk (partial): {shrunk_batches}')
print(f'Batches remaining: {len(new_batches)} (was 610)')

with open(manifest_path, 'w') as f:
    json.dump(m, f, indent=2)
print('Manifest updated.')
