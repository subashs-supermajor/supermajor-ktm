#!/usr/bin/env python3
"""
Repacks GLB files with smaller textures so they don't blow the GPU budget on iPhone.

Before: 4096x4096 PNG textures  → ~48 MB VRAM each → ~384 MB for 2 variants → GPU crash
After:  2048x2048 JPEG textures → ~12 MB VRAM each → ~96 MB for 2 variants → safe

Usage:  python tools/compress_glb_textures.py
Output: Scooter-opt.glb / Scooter-Orange-opt.glb / Scooter-Red-opt.glb
        Review them in a 3D viewer, then rename to replace the originals.
"""

import struct, json, io, sys, shutil
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'Pillow', '-q'])
    from PIL import Image

MAX_SIZE   = 2048   # max texture dimension on either axis
JPEG_Q     = 88     # JPEG quality for RGB textures
MODELS_DIR = Path(__file__).parent.parent / 'public' / 'assets' / 'models' / 'ktm-390-duke'

VARIANTS = [
    ('Scooter.glb',      'Scooter-opt.glb'),
    ('Scooter-Orange.glb', 'Scooter-Orange-opt.glb'),
    ('Scooter-Red.glb',  'Scooter-Red-opt.glb'),
]


def _parse_chunks(raw: bytes):
    """Return (json_dict, json_chunk_start, bin_data, bin_chunk_start) or raise."""
    if raw[:4] != b'glTF' or struct.unpack_from('<I', raw, 4)[0] != 2:
        raise ValueError('Not a GLB v2 file')
    off = 12
    json_dict = json_start = bin_data = bin_start = None
    while off < len(raw):
        length, ctype = struct.unpack_from('<II', raw, off)
        chunk = raw[off + 8: off + 8 + length]
        if ctype == 0x4E4F534A:          # JSON
            json_dict  = json.loads(chunk.rstrip(b'\x00'))
            json_start = off
        elif ctype == 0x004E4942:        # BIN
            bin_data   = bytearray(chunk)
            bin_start  = off
        off += 8 + length
        if off % 4:
            off += 4 - off % 4
    return json_dict, json_start, bin_data, bin_start


def _build_glb(json_dict: dict, bin_data: bytes) -> bytes:
    json_bytes = json.dumps(json_dict, separators=(',', ':')).encode()
    # pad to 4-byte boundary
    while len(json_bytes) % 4:
        json_bytes += b' '
    bin_padded = bytearray(bin_data)
    while len(bin_padded) % 4:
        bin_padded.append(0)

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_padded)
    out = bytearray()
    out += struct.pack('<III', 0x46546C67, 2, total)         # GLB header
    out += struct.pack('<II', len(json_bytes), 0x4E4F534A)   # JSON chunk header
    out += json_bytes
    out += struct.pack('<II', len(bin_padded), 0x004E4942)   # BIN chunk header
    out += bin_padded
    return bytes(out)


def compress_glb(src: Path, dst: Path):
    print(f'\n{src.name}  ({src.stat().st_size // 1024} KB)')
    raw = src.read_bytes()
    j, _js, bin_data, _bs = _parse_chunks(raw)

    images   = j.get('images', [])
    bv_list  = j['bufferViews']

    # Build a sorted list of (byteOffset, bufferViewIndex) for the binary chunk
    # so we can rebuild it in order after replacing image data.
    bv_data = []   # list of (byteOffset, bytes) for each bufferView
    for bv in bv_list:
        bo = bv.get('byteOffset', 0)
        bl = bv['byteLength']
        bv_data.append(bytearray(bin_data[bo: bo + bl]))

    # Set of bufferView indices that are images
    img_bv_indices = {img['bufferView'] for img in images if 'bufferView' in img}

    for img_i, img in enumerate(images):
        bv_idx = img.get('bufferView')
        if bv_idx is None:
            continue
        old_bytes = bytes(bv_data[bv_idx])
        try:
            im = Image.open(io.BytesIO(old_bytes))
        except Exception as e:
            print(f'  tex{img_i}: unreadable ({e})')
            continue

        orig_w, orig_h = im.size
        has_alpha = im.mode in ('RGBA', 'LA', 'PA')

        # Resize if either dimension exceeds MAX_SIZE
        if max(orig_w, orig_h) > MAX_SIZE:
            scale = MAX_SIZE / max(orig_w, orig_h)
            new_w, new_h = int(orig_w * scale), int(orig_h * scale)
            im = im.resize((new_w, new_h), Image.LANCZOS)
        else:
            new_w, new_h = orig_w, orig_h

        buf = io.BytesIO()
        if has_alpha:
            im.convert('RGBA').save(buf, format='PNG', optimize=True)
            new_mime = 'image/png'
        else:
            im.convert('RGB').save(buf, format='JPEG', quality=JPEG_Q, optimize=True)
            new_mime = 'image/jpeg'

        new_bytes = buf.getvalue()
        bv_data[bv_idx] = bytearray(new_bytes)
        img['mimeType'] = new_mime

        old_kb  = len(old_bytes) // 1024
        new_kb  = len(new_bytes) // 1024
        savings = 100 - int(100 * new_kb / max(old_kb, 1))
        print(f'  tex{img_i}: {orig_w}x{orig_h} → {new_w}x{new_h}  '
              f'{old_kb} KB → {new_kb} KB  (-{savings}%)  {"PNG" if has_alpha else "JPEG"}')

    # Rebuild binary chunk: concatenate bufferView blocks with 4-byte alignment
    new_bin = bytearray()
    for i, bv_bytes in enumerate(bv_data):
        bv_list[i]['byteOffset'] = len(new_bin)
        bv_list[i]['byteLength'] = len(bv_bytes)
        new_bin += bv_bytes
        while len(new_bin) % 4:
            new_bin.append(0)

    # Update the buffer total byte length
    if j.get('buffers'):
        j['buffers'][0]['byteLength'] = len(new_bin)

    out = _build_glb(j, bytes(new_bin))
    dst.write_bytes(out)
    print(f'  → {dst.name}  ({len(out) // 1024} KB)  '
          f'saved {(src.stat().st_size - len(out)) // 1024} KB')


if __name__ == '__main__':
    for src_name, dst_name in VARIANTS:
        src = MODELS_DIR / src_name
        dst = MODELS_DIR / dst_name
        if not src.exists():
            print(f'SKIP {src_name}: not found')
            continue
        compress_glb(src, dst)

    print('\nDone.')
    print('Review in a 3D viewer (e.g. gltf.report or model-viewer), then rename:')
    print('  Scooter-opt.glb      → Scooter.glb')
    print('  Scooter-Orange-opt.glb → Scooter-Orange.glb')
    print('  Scooter-Red-opt.glb  → Scooter-Red.glb')
