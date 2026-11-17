#!/usr/bin/env python3
"""
GLB → USDZ converter using the same USDA format as three.js USDZExporter.
Requires: pip install pygltflib Pillow numpy   (auto-installed on first run)
Usage:    python tools/glb_to_usdz.py
"""

import sys, os, io, struct, zipfile, zlib, math
from pathlib import Path

# ── auto-install deps ─────────────────────────────────────────────────────────
def _ensure(*pkgs):
    missing = []
    for p in pkgs:
        try:
            __import__(p.split("==")[0].replace("-", "_"))
        except ImportError:
            missing.append(p)
    if missing:
        import subprocess
        subprocess.check_call([sys.executable, "-m", "pip", "install", *missing, "-q"])

_ensure("pygltflib", "numpy", "Pillow")

import pygltflib
import numpy as np
from PIL import Image

PRECISION = 6
MAX_TEX = 2048

# ── GLB reading ───────────────────────────────────────────────────────────────
_COMP_FMT  = {5120:'b', 5121:'B', 5122:'h', 5123:'H', 5125:'I', 5126:'f'}
_COMP_SIZE = {5120:1,   5121:1,   5122:2,   5123:2,   5125:4,   5126:4  }
_TYPE_CNT  = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4,"MAT2":4,"MAT3":9,"MAT4":16}

def _bv_bytes(gltf, bv_idx):
    bv = gltf.bufferViews[bv_idx]
    off = bv.byteOffset or 0
    return gltf.binary_blob()[off:off + bv.byteLength]

def read_accessor(gltf, idx):
    if idx is None:
        return None
    acc = gltf.accessors[idx]
    if acc.sparse is not None:
        raise ValueError(f"sparse accessor {idx} not supported")
    n   = _TYPE_CNT[acc.type]
    dt  = np.dtype('<' + _COMP_FMT[acc.componentType])
    sz  = _COMP_SIZE[acc.componentType]
    bv  = gltf.bufferViews[acc.bufferView]
    raw = _bv_bytes(gltf, acc.bufferView)
    stride = bv.byteStride or (sz * n)
    base   = acc.byteOffset or 0
    if stride == sz * n:
        arr = np.frombuffer(raw, dtype=dt, count=acc.count * n, offset=base).reshape(acc.count, n)
    else:
        arr = np.lib.stride_tricks.as_strided(
            np.frombuffer(raw, dtype=np.uint8, offset=base),
            shape=(acc.count, n * sz), strides=(stride, 1)).copy().view(dt).reshape(acc.count, n)
    if acc.normalized and dt.kind in 'iu':
        arr = arr.astype(np.float32) / np.iinfo(dt).max
    arr = arr.astype(np.float32 if (dt.kind == 'f' or acc.normalized) else np.int64)
    return arr.ravel() if n == 1 else arr

def get_image_bytes(gltf, img_idx):
    img = gltf.images[img_idx]
    if img.bufferView is not None:
        return bytes(_bv_bytes(gltf, img.bufferView)), (img.mimeType or "image/png")
    if img.uri and img.uri.startswith("data:"):
        import base64
        header, data = img.uri.split(",", 1)
        mime = header.split(";")[0].split(":")[1]
        return base64.b64decode(data), mime
    return b"", "image/png"

# ── USDA builders  ────────────────────────────────────────────────────────────
def _header():
    return (
        '#usda 1.0\n(\n'
        '\tcustomLayerData = {\n\t\tstring creator = "Three.js USDZExporter"\n\t}\n'
        '\tdefaultPrim = "Root"\n\tmetersPerUnit = 1\n\tupAxis = "Y"\n)\n\n'
    )

def _v3(arr, p=PRECISION):
    return ",".join(f"({r[0]:.{p}g},{r[1]:.{p}g},{r[2]:.{p}g})" for r in arr.tolist())

def _v2(arr, p=5):
    # flip V: GLB origin=top-left, USD origin=bottom-left
    return ",".join(f"({r[0]:.{p}g},{1.0 - r[1]:.{p}g})" for r in arr.tolist())

def _ints(arr):
    return ",".join(map(str, arr.tolist()))

def _mat_usda(m):
    # USD row-major with translation in last row (DirectX)
    # Input m is numpy OpenGL-style (translation in last column) → transpose
    rows = m.T
    return "( " + ", ".join(
        f"({', '.join(f'{v:.{PRECISION}g}' for v in row)})" for row in rows
    ) + " )"

def build_geometry_usda(positions, normals, uvs, indices):
    n_tris = len(indices) // 3
    counts = ",".join(["3"] * n_tris)
    lines  = [
        'def "Geometry"\n{',
        '\tdef Mesh "Geometry"\n\t{',
        f'\t\tint[] faceVertexCounts = [{counts}]',
        f'\t\tint[] faceVertexIndices = [{_ints(indices)}]',
    ]
    if normals is not None and len(normals):
        lines.append(
            f'\t\tnormal3f[] normals = [{_v3(normals, 4)}] (\n\t\t\tinterpolation = "vertex"\n\t\t)'
        )
    lines.append(f'\t\tpoint3f[] points = [{_v3(positions)}]')
    if uvs is not None and len(uvs):
        lines.append(
            f'\t\ttexCoord2f[] primvars:st = [{_v2(uvs)}] (\n\t\t\tinterpolation = "vertex"\n\t\t)'
        )
    lines += ['\t\tuniform token subdivisionScheme = "none"', '\t}', '}']
    return _header() + "\n".join(lines) + "\n"

def _tex_sampler(ti, map_type, tf, mid, cs, scale_bias=False):
    # Tangent-space normals are stored 0..1; UsdPreviewSurface wants -1..1.
    sb = ("\n\t\t\tfloat4 inputs:scale = (2, 2, 2, 1)\n\t\t\tfloat4 inputs:bias = (-1, -1, -1, 0)"
          if scale_bias else "")
    return f"""
\t\tdef Shader "PrimvarReader_{map_type}"
\t\t{{
\t\t\tuniform token info:id = "UsdPrimvarReader_float2"
\t\t\tfloat2 inputs:fallback = (0.0, 0.0)
\t\t\ttoken inputs:varname = "st"
\t\t\tfloat2 outputs:result
\t\t}}
\t\tdef Shader "Texture_{ti}_{map_type}"
\t\t{{
\t\t\tuniform token info:id = "UsdUVTexture"
\t\t\tasset inputs:file = @{tf}@
\t\t\tfloat2 inputs:st.connect = </Materials/{mid}/PrimvarReader_{map_type}.outputs:result>
\t\t\ttoken inputs:sourceColorSpace = "{cs}"
\t\t\ttoken inputs:wrapS = "repeat"
\t\t\ttoken inputs:wrapT = "repeat"{sb}
\t\t\tfloat outputs:a
\t\t\tfloat outputs:r
\t\t\tfloat outputs:g
\t\t\tfloat outputs:b
\t\t\tfloat3 outputs:rgb
\t\t}}"""

def build_material(gltf, mat_idx, tex_files):
    if mat_idx is None or mat_idx >= len(gltf.materials):
        mat_idx = 0
    if not gltf.materials:
        return ""
    mat  = gltf.materials[min(mat_idx, len(gltf.materials) - 1)]
    mid  = f"Material_{mat_idx}"
    pbr  = mat.pbrMetallicRoughness
    pref = f"/Materials/{mid}"
    inputs, samplers = [], []
    alpha_mode = mat.alphaMode or "OPAQUE"
    transmission = ((mat.extensions or {}).get("KHR_materials_transmission") or {}).get("transmissionFactor", 0) or 0

    # diffuse / base colour
    if pbr and pbr.baseColorTexture is not None:
        ti = pbr.baseColorTexture.index
        tf = tex_files.get(ti, f"textures/Texture_{ti}.png")
        inputs.append(f"\t\t\tcolor3f inputs:diffuseColor.connect = <{pref}/Texture_{ti}_diffuse.outputs:rgb>")
        if alpha_mode != "OPAQUE" and tf.endswith(".png"):
            inputs.append(f"\t\t\tfloat inputs:opacity.connect = <{pref}/Texture_{ti}_diffuse.outputs:a>")
            if alpha_mode == "MASK":
                inputs.append(f"\t\t\tfloat inputs:opacityThreshold = {mat.alphaCutoff if mat.alphaCutoff is not None else 0.5:.3g}")
        samplers.append(_tex_sampler(ti, 'diffuse', tf, mid, 'sRGB'))
    else:
        bc = (pbr.baseColorFactor if pbr and pbr.baseColorFactor else [1, 1, 1, 1])
        inputs.append(f"\t\t\tcolor3f inputs:diffuseColor = ({bc[0]:.{PRECISION}g}, {bc[1]:.{PRECISION}g}, {bc[2]:.{PRECISION}g})")

    # metallic + roughness
    if pbr and pbr.metallicRoughnessTexture is not None:
        ti = pbr.metallicRoughnessTexture.index
        tf = tex_files.get(ti, f"textures/Texture_{ti}.png")
        inputs.append(f"\t\t\tfloat inputs:roughness.connect = <{pref}/Texture_{ti}_roughness.outputs:g>")
        inputs.append(f"\t\t\tfloat inputs:metallic.connect = <{pref}/Texture_{ti}_metallic.outputs:b>")
        samplers.append(_tex_sampler(ti, 'roughness', tf, mid, 'raw'))
        samplers.append(_tex_sampler(ti, 'metallic',  tf, mid, 'raw'))
    else:
        rough = (pbr.roughnessFactor if pbr and pbr.roughnessFactor is not None else 1.0)
        metal = (pbr.metallicFactor  if pbr and pbr.metallicFactor  is not None else 1.0)
        inputs.append(f"\t\t\tfloat inputs:roughness = {rough:.{PRECISION}g}")
        inputs.append(f"\t\t\tfloat inputs:metallic = {metal:.{PRECISION}g}")

    # normal map
    if mat.normalTexture is not None:
        ti = mat.normalTexture.index
        tf = tex_files.get(ti, f"textures/Texture_{ti}.png")
        inputs.append(f"\t\t\tnormal3f inputs:normal.connect = <{pref}/Texture_{ti}_normal.outputs:rgb>")
        samplers.append(_tex_sampler(ti, 'normal', tf, mid, 'raw', scale_bias=True))

    # emissive
    if mat.emissiveTexture is not None:
        ti = mat.emissiveTexture.index
        tf = tex_files.get(ti, f"textures/Texture_{ti}.png")
        inputs.append(f"\t\t\tcolor3f inputs:emissiveColor.connect = <{pref}/Texture_{ti}_emissive.outputs:rgb>")
        samplers.append(_tex_sampler(ti, 'emissive', tf, mid, 'sRGB'))
    elif mat.emissiveFactor and any(v > 0 for v in mat.emissiveFactor):
        ef = mat.emissiveFactor
        inputs.append(f"\t\t\tcolor3f inputs:emissiveColor = ({ef[0]:.{PRECISION}g}, {ef[1]:.{PRECISION}g}, {ef[2]:.{PRECISION}g})")

    if not any("inputs:opacity" in l for l in inputs):
        # Quick Look has no transmission; approximate glass with partial opacity.
        opacity = 1 - 0.7 * transmission
        if alpha_mode == "BLEND" and pbr and pbr.baseColorFactor:
            opacity *= pbr.baseColorFactor[3]
        inputs.append(f"\t\t\tfloat inputs:opacity = {opacity:.3g}")
    inputs.append("\t\t\tint inputs:useSpecularWorkflow = 0")

    return f"""
\tdef Material "{mid}"
\t{{
\t\ttoken outputs:surface.connect = <{pref}/PBRShader.outputs:surface>

\t\tdef Shader "PBRShader"
\t\t{{
\t\t\tuniform token info:id = "UsdPreviewSurface"
{chr(10).join(inputs)}
\t\t\ttoken outputs:surface
\t\t}}
{''.join(samplers)}
\t}}
"""

def build_xform_ref(obj_name, geom_id, world_m, mat_idx):
    mat_line = f'\trel material:binding = </Materials/Material_{mat_idx}>' if mat_idx is not None else ""
    return (
        f'def Xform "{obj_name}" (\n'
        f'\tprepend references = @./geometries/Geometry_{geom_id}.usda@</Geometry>\n'
        f'\tprepend apiSchemas = ["MaterialBindingAPI"]\n'
        f')\n{{\n'
        f'\tmatrix4d xformOp:transform = {_mat_usda(world_m)}\n'
        f'\tuniform token[] xformOpOrder = ["xformOp:transform"]\n'
        f'{mat_line}\n}}\n\n'
    )

# ── Node tree ─────────────────────────────────────────────────────────────────
def _identity():
    return np.eye(4, dtype=np.float64)

def _node_local(node):
    if node.matrix:
        # GLB column-major → numpy row-major by reshape then transpose
        return np.array(node.matrix, dtype=np.float64).reshape(4, 4, order='F')
    m = _identity()
    if node.translation:
        m[:3, 3] = node.translation
    if node.rotation:
        x, y, z, w = node.rotation
        m[0,0]=1-2*(y*y+z*z); m[0,1]=2*(x*y-z*w); m[0,2]=2*(x*z+y*w)
        m[1,0]=2*(x*y+z*w);   m[1,1]=1-2*(x*x+z*z); m[1,2]=2*(y*z-x*w)
        m[2,0]=2*(x*z-y*w);   m[2,1]=2*(y*z+x*w);   m[2,2]=1-2*(x*x+y*y)
    if node.scale:
        s = node.scale
        m[:3, 0] *= s[0]; m[:3, 1] *= s[1]; m[:3, 2] *= s[2]
    return m

def collect_mesh_nodes(gltf, node_idx, parent_world=None):
    if parent_world is None:
        parent_world = _identity()
    node  = gltf.nodes[node_idx]
    world = parent_world @ _node_local(node)
    result = []
    if node.mesh is not None:
        result.append((node, world, node.mesh))
    for ci in (node.children or []):
        result.extend(collect_mesh_nodes(gltf, ci, world))
    return result

# ── USDZ writer (64-byte aligned ZIP) ────────────────────────────────────────
class _USDZWriter:
    def __init__(self):
        self._buf = io.BytesIO()
        self._entries = []
        self._offset  = 0

    def add(self, name, data):
        if isinstance(data, str):
            data = data.encode('utf-8')
        fname = name.encode('utf-8')
        # Pad so data starts at 64-byte boundary
        hdr_sz   = 30 + len(fname)
        pad_len  = (64 - ((self._offset + hdr_sz) % 64)) % 64
        if 0 < pad_len < 4:
            pad_len += 64
        # Well-formed extra-field record (tag 0x3039, like three.js/fflate) carrying the padding.
        extra = struct.pack('<HH', 12345, pad_len - 4) + b'\x00' * (pad_len - 4) if pad_len else b''
        crc      = zlib.crc32(data) & 0xFFFFFFFF
        hdr = struct.pack('<4sHHHHHIIIHH',
            b'PK\x03\x04', 20, 0, 0, 0, 0,
            crc, len(data), len(data), len(fname), len(extra))
        self._buf.write(hdr); self._buf.write(fname); self._buf.write(extra)
        self._buf.write(data)
        self._entries.append({'name': fname, 'crc': crc, 'size': len(data),
                              'local_off': self._offset})
        self._offset += 30 + len(fname) + len(extra) + len(data)

    def save(self, path):
        cd_start = self._offset
        cd_parts = []
        for e in self._entries:
            cd_parts.append(struct.pack('<4sHHHHHHIIIHHHHHII',
                b'PK\x01\x02', 20, 20, 0, 0, 0, 0,
                e['crc'], e['size'], e['size'],
                len(e['name']), 0, 0, 0, 0, 0, e['local_off']) + e['name'])
        for cd in cd_parts:
            self._buf.write(cd)
        cd_size = sum(len(c) for c in cd_parts)
        self._buf.write(struct.pack('<4sHHHHIIH',
            b'PK\x05\x06', 0, 0,
            len(self._entries), len(self._entries),
            cd_size, cd_start, 0))
        Path(path).write_bytes(self._buf.getvalue())

# ── Main converter ────────────────────────────────────────────────────────────
def convert_glb_to_usdz(glb_path, usdz_path):
    print(f"  Loading  {Path(glb_path).name} ...", end=" ", flush=True)
    gltf = pygltflib.GLTF2().load(str(glb_path))
    print("done")

    writer   = _USDZWriter()
    files    = {}   # name → bytes/str, in insertion order
    # model.usda must be first file in the archive
    files["model.usda"] = None   # placeholder, filled later

    # --- process scene ---
    scene = gltf.scenes[gltf.scene if gltf.scene is not None else 0]
    mesh_nodes = []
    for root_idx in scene.nodes:
        mesh_nodes.extend(collect_mesh_nodes(gltf, root_idx))

    xform_usda = ""
    geom_counter = 0
    mat_indices  = set()

    for _node, world_m, mesh_idx in mesh_nodes:
        mesh = gltf.meshes[mesh_idx]
        mname = (mesh.name or f"Mesh_{mesh_idx}").replace(" ", "_").replace(".", "_")

        for pi, prim in enumerate(mesh.primitives):
            mat_idx = prim.material  # may be None

            # geometry
            pos  = read_accessor(gltf, prim.attributes.POSITION)
            nrm  = read_accessor(gltf, prim.attributes.NORMAL)
            uv   = read_accessor(gltf, getattr(prim.attributes, 'TEXCOORD_0', None))
            if prim.indices is not None:
                idx = read_accessor(gltf, prim.indices)
            else:
                idx = np.arange(len(pos), dtype=np.int64)

            if pos is None or len(pos) == 0:
                continue

            geom_id  = geom_counter
            geom_counter += 1
            geom_file = f"geometries/Geometry_{geom_id}.usda"
            files[geom_file] = build_geometry_usda(pos, nrm, uv, idx)

            obj_name = f"Object_{geom_id}_{mname}_{pi}"
            xform_usda += build_xform_ref(obj_name, geom_id, world_m, mat_idx)
            if mat_idx is not None:
                mat_indices.add(mat_idx)

    # --- textures ---
    tex_idx_set = set()
    for mi in mat_indices:
        if mi >= len(gltf.materials): continue
        m   = gltf.materials[mi]
        pbr = m.pbrMetallicRoughness
        if pbr:
            if pbr.baseColorTexture:         tex_idx_set.add(pbr.baseColorTexture.index)
            if pbr.metallicRoughnessTexture: tex_idx_set.add(pbr.metallicRoughnessTexture.index)
        if m.normalTexture:  tex_idx_set.add(m.normalTexture.index)
        if m.emissiveTexture: tex_idx_set.add(m.emissiveTexture.index)

    # Base-colour maps of non-opaque materials keep their alpha channel (PNG).
    alpha_tex = {
        m.pbrMetallicRoughness.baseColorTexture.index
        for mi in mat_indices if mi < len(gltf.materials)
        for m in [gltf.materials[mi]]
        if (m.alphaMode or "OPAQUE") != "OPAQUE" and m.pbrMetallicRoughness and m.pbrMetallicRoughness.baseColorTexture
    }

    tex_files = {}
    print(f"  Textures ({len(tex_idx_set)}) ...", end=" ", flush=True)
    for ti in sorted(tex_idx_set):
        tex     = gltf.textures[ti]
        img_idx = tex.source if tex.source is not None else ti
        raw, _mime = get_image_bytes(gltf, img_idx)
        if not raw: continue
        img = Image.open(io.BytesIO(raw))
        if max(img.size) > MAX_TEX:
            img.thumbnail((MAX_TEX, MAX_TEX), Image.LANCZOS)
        buf = io.BytesIO()
        if ti in alpha_tex:
            img.convert("RGBA").save(buf, format="PNG", optimize=True)
            tf = f"textures/Texture_{ti}.png"
        else:
            img.convert("RGB").save(buf, format="JPEG", quality=90)
            tf = f"textures/Texture_{ti}.jpg"
        files[tf]     = buf.getvalue()
        tex_files[ti] = tf
    print("done")

    # --- materials ---
    mat_usda = 'def "Materials"\n{\n'
    for mi in sorted(mat_indices):
        mat_usda += build_material(gltf, mi, tex_files)
    mat_usda += "}\n\n"

    # --- assemble model.usda ---
    main = _header()
    main += 'def Xform "Root"\n{\n'
    main += '\tdef Scope "Scenes" (\n\t\tkind = "sceneLibrary"\n\t)\n\t{\n'
    main += '\t\tdef Xform "Scene" (\n'
    main += '\t\t\tcustomData = {\n\t\t\t\tbool preliminary_collidesWithEnvironment = 0\n'
    main += '\t\t\t\tstring sceneName = "Scene"\n\t\t\t}\n\t\t\tsceneName = "Scene"\n\t\t)\n\t\t{\n'
    main += '\t\t\ttoken preliminary:anchoring:type = "plane"\n'
    main += '\t\t\ttoken preliminary:planeAnchoring:alignment = "horizontal"\n'
    # indent xforms
    for line in xform_usda.splitlines():
        main += ("\t\t\t" + line).rstrip() + "\n"
    main += "\t\t}\n\t}\n}\n\n"
    main += mat_usda
    files["model.usda"] = main

    # --- write USDZ ---
    print(f"  Packing  {Path(usdz_path).name} ...", end=" ", flush=True)
    for name, data in files.items():
        writer.add(name, data)
    writer.save(str(usdz_path))
    mb = Path(usdz_path).stat().st_size / 1_048_576
    print(f"done  ({mb:.1f} MB)")

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    models = Path(__file__).parent.parent / "public" / "assets" / "models" / "ktm-390-duke"
    variants = [
        ("Scooter.glb",      "Scooter-White.usdz"),
        ("Scooter-Orange.glb", "Scooter-Orange.usdz"),
        ("Scooter-Red.glb",  "Scooter-Red.usdz"),
    ]
    for glb_name, usdz_name in variants:
        glb  = models / glb_name
        usdz = models / usdz_name
        if not glb.exists():
            print(f"SKIP {glb_name}: not found"); continue
        print(f"\n{glb_name} → {usdz_name}")
        convert_glb_to_usdz(glb, usdz)

    print("\nAll done! Upload the .usdz files to Vercel alongside the GLBs.")
