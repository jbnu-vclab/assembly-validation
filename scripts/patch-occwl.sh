#!/usr/bin/env bash
# occwl 3.0.0 + pythonocc-core 7.9.x compatibility patches
set -euo pipefail

CONDA_ENV="${CONDA_ENV:-dc}"

if command -v conda >/dev/null 2>&1 && conda env list | awk '{print $1}' | grep -qx "$CONDA_ENV"; then
	PYTHON=(conda run -n "$CONDA_ENV" python)
else
	PYTHON=(python)
fi

OCCWL_DIR="$("${PYTHON[@]}" -c "import occwl, pathlib; print(pathlib.Path(occwl.__file__).parent)" 2>/dev/null || true)"
if [[ -z "$OCCWL_DIR" || ! -d "$OCCWL_DIR" ]]; then
	echo "[patch-occwl] occwl not installed — skip (conda activate $CONDA_ENV && pip install -r requirements.txt 후 다시 실행)"
	exit 0
fi

"${PYTHON[@]}" <<PY
from pathlib import Path

occwl_dir = Path("$OCCWL_DIR")
changed = False

compound = occwl_dir / "compound.py"
text = compound.read_text()
old_import = "from OCC.Extend.DataExchange import read_step_file, list_of_shapes_to_compound"
new_import = "from OCC.Extend.DataExchange import read_step_file\nfrom OCC.Extend.TopologyUtils import list_of_shapes_to_compound"
if old_import in text:
	compound.write_text(text.replace(old_import, new_import, 1))
	print("[patch-occwl] patched compound.py import")
	changed = True
elif "from OCC.Extend.TopologyUtils import list_of_shapes_to_compound" in text:
	print("[patch-occwl] compound.py already patched")
else:
	raise SystemExit("[patch-occwl] unexpected compound.py — manual fix needed")

face = occwl_dir / "face.py"
text = face.read_text()
if "facing.Node(i)" in text:
	print("[patch-occwl] face.py already patched")
else:
	old_block = """        vert_nodes = facing.Nodes()
        tri = facing.Triangles()
        uv_nodes = facing.UVNodes()
        verts = []
        normals = []
        for i in range(1, facing.NbNodes() + 1):
            vert = vert_nodes.Value(i).Transformed(location.Transformation())
            verts.append(np.array(list(vert.Coord())))
            if return_normals:
                uv = uv_nodes.Value(i).Coord()
                normal = self.normal(uv)
                normals.append(normal)

        tris = []
        reversed = self.reversed()
        for i in range(1, facing.NbTriangles() + 1):
            # OCC triangle normals point in the surface normal
            # direction
            if reversed:
                index1, index3, index2 = tri.Value(i).Get()
            else:
                index1, index2, index3 = tri.Value(i).Get()

            tris.append([index1 - 1, index2 - 1, index3 - 1])"""
	new_block = """        verts = []
        normals = []
        for i in range(1, facing.NbNodes() + 1):
            vert = facing.Node(i).Transformed(location.Transformation())
            verts.append(np.array(list(vert.Coord())))
            if return_normals:
                uv = facing.UVNode(i).Coord()
                normal = self.normal(uv)
                normals.append(normal)

        tris = []
        reversed = self.reversed()
        for i in range(1, facing.NbTriangles() + 1):
            # OCC triangle normals point in the surface normal
            # direction
            if reversed:
                index1, index3, index2 = facing.Triangle(i).Get()
            else:
                index1, index2, index3 = facing.Triangle(i).Get()

            tris.append([index1 - 1, index2 - 1, index3 - 1])"""
	if old_block not in text:
		raise SystemExit("[patch-occwl] unexpected face.py — manual fix needed")
	face.write_text(text.replace(old_block, new_block, 1))
	print("[patch-occwl] patched face.py get_triangles for pythonocc-core 7.9")
	changed = True

if not changed:
	print("[patch-occwl] no changes needed")
PY

"${PYTHON[@]}" -c "from occwl.compound import Compound; from occwl.face import Face"
