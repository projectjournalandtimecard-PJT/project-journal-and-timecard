"""Build app-icon.png (1024, RGBA, transparent corners) and icon.icns from the
JPEG-that-was-named-.png source. Writes to temp names, validates, then swaps."""
import struct, io, os
from PIL import Image
from collections import deque

SRC = '/mnt/project/pjticonfinal1024.png'
OUT = '/home/claude/build/icons'
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert('RGBA')
w, h = im.size
px = im.load()

# Flood-fill the white JPEG corners to transparent. Fill from the four corners
# only, so white INSIDE the artwork (the ring, the letters) is never touched.
def near_white(p):
    return p[0] > 238 and p[1] > 238 and p[2] > 238

seen = bytearray(w * h)
q = deque()
for c in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
    if near_white(px[c]):
        q.append(c); seen[c[1] * w + c[0]] = 1
while q:
    x, y = q.popleft()
    px[x, y] = (255, 255, 255, 0)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and near_white(px[nx, ny]):
            seen[ny * w + nx] = 1; q.append((nx, ny))

# Trim any fully transparent margin, then square up and resize to 1024.
bbox = im.getbbox()
im = im.crop(bbox)
side = max(im.size)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(im, ((side - im.size[0]) // 2, (side - im.size[1]) // 2))
master = sq.resize((1024, 1024), Image.LANCZOS)

master.save(OUT + '/app-icon.png.tmp', 'PNG')

# --- icns ---------------------------------------------------------------
# Container: b'icns' + total length, then typed entries of
# 4-byte type + 4-byte length (including the 8-byte header) + PNG payload.
TYPES = [('icp4', 16), ('icp5', 32), ('ic11', 32), ('ic12', 64),
         ('ic07', 128), ('ic13', 256), ('ic08', 256), ('ic14', 512),
         ('ic09', 512), ('ic10', 1024)]

parts = []
for tag, size in TYPES:
    buf = io.BytesIO()
    master.resize((size, size), Image.LANCZOS).save(buf, 'PNG')
    data = buf.getvalue()
    parts.append(tag.encode('ascii') + struct.pack('>I', len(data) + 8) + data)

body = b''.join(parts)
icns = b'icns' + struct.pack('>I', len(body) + 8) + body
open(OUT + '/icon.icns.tmp', 'wb').write(icns)

# --- validate by re-parsing before swapping in ---------------------------
d = open(OUT + '/icon.icns.tmp', 'rb').read()
assert d[:4] == b'icns', 'bad magic'
total = struct.unpack('>I', d[4:8])[0]
assert total == len(d), 'declared length %d != actual %d' % (total, len(d))
off, found = 8, []
while off < len(d):
    tag = d[off:off + 4].decode('ascii')
    ln = struct.unpack('>I', d[off + 4:off + 8])[0]
    payload = d[off + 8:off + ln]
    assert payload[:8] == b'\x89PNG\r\n\x1a\n', tag + ' payload is not PNG'
    iw, ih = struct.unpack('>II', payload[16:24])
    found.append((tag, iw, ih))
    off += ln
assert off == len(d), 'entries overran the container'

chk = Image.open(OUT + '/app-icon.png.tmp')
assert chk.mode == 'RGBA' and chk.size == (1024, 1024), 'master png wrong'
assert chk.getpixel((0, 0))[3] == 0, 'top-left corner is not transparent'

os.replace(OUT + '/icon.icns.tmp', OUT + '/icon.icns')
os.replace(OUT + '/app-icon.png.tmp', OUT + '/app-icon.png')

print('icon.icns entries:')
for tag, iw, ih in found:
    print('   %s  %dx%d' % (tag, iw, ih))
print('\nicon.icns   %d bytes' % len(d))
print('app-icon.png %d bytes, %s %s' % (os.path.getsize(OUT + '/app-icon.png'), chk.mode, chk.size))
