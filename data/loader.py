# STEP 파일을 읽어 몸체마다 삼각형 메쉬와 이름을 만든다.
# 이름은 STEP 텍스트의 PRODUCT 구조를 직접 파싱해 붙이고, 없으면 OCC가 읽은 이름,
# 그래도 없으면 메쉬 해시(서명)를 쓴다.
import contextlib
import hashlib
import io
import re

from typing import Dict, List, Tuple

import numpy as np
from concurrent.futures import ThreadPoolExecutor, as_completed
from trimesh import Trimesh
from occwl.compound import Compound

from OCC.Core.BRep import BRep_Tool
from OCC.Core.BRepMesh import BRepMesh_IncrementalMesh
from OCC.Core.BRepTools import breptools
from OCC.Core.TopAbs import TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID
from OCC.Core.TopAbs import TopAbs_VERTEX
from OCC.Core.TopExp import TopExp_Explorer, topexp
from OCC.Core.TopLoc import TopLoc_Location
from OCC.Core.TopoDS import topods
from OCC.Core.TopTools import TopTools_IndexedDataMapOfShapeListOfShape


# 괄호 밖이면서 따옴표 밖에 있는 separator에서만 문자열을 나눈다('' 이스케이프 처리 포함).
def _split_top_level(text: str, separator: str) -> List[str]:
    pieces, depth, quoted, start, index = list(), 0, False, 0, 0
    while index < len(text):
        character = text[index]
        if quoted:
            if character == "'":
                if index + 1 < len(text) and text[index + 1] == "'":
                    index += 2
                    continue
                quoted = False
        elif character == "'":
            quoted = True
        elif character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
        elif character == separator and depth == 0:
            pieces.append(text[start:index])
            start = index + 1
        index += 1
    pieces.append(text[start:])
    return pieces


# STEP의 DATA 구역을 파싱해 {엔티티 번호: (타입 이름, 인자 문자열)}을 만든다.
def _parse_step_entities(path: str):
    with open(path, "r", errors="replace") as handle:
        text = handle.read()
    upper = text.upper()
    # DATA;부터 마지막 ENDSEC; 사이 본문에서 /* */ 주석을 지운다.
    body = re.sub(r"/\*.*?\*/", "",
                  text[upper.index("DATA;") + 5: upper.rindex("ENDSEC;")], flags=re.S)
    entities = dict()
    for statement in _split_top_level(body, ";"):
        statement = statement.strip()
        if not statement.startswith("#"):
            continue
        head = re.match(r"#(\d+)\s*=\s*", statement)
        if head is None:
            continue
        rest = statement[head.end():].strip()
        # 타입 이름 없이 괄호로 시작하는 복합 엔티티는 '__COMPLEX__'로 둔다.
        named = re.match(r"([A-Za-z0-9_]+)\s*\(", rest)
        if named is None:
            entities[int(head.group(1))] = ("__COMPLEX__", rest)
            continue
        entities[int(head.group(1))] = (
            named.group(1).upper(),
            rest[named.end():-1] if rest.endswith(")") else rest[named.end():],
        )
    return entities


# 인자 문자열 안의 엔티티 참조(#번호)를 정수 목록으로 뽑는다.
def _entity_references(argument_text: str) -> List[int]:
    return [int(value) for value in re.findall(r"#(\d+)", argument_text)]


# 인자 문자열 안의 작은따옴표 문자열들을 뽑는다('' → ').
def _entity_strings(argument_text: str) -> List[str]:
    return [match.group(1).replace("''", "'")
            for match in re.finditer(r"'((?:[^']|'')*)'", argument_text)]


# 솔리드 형상으로 보는 STEP 엔티티 타입
_SOLID_ENTITY_TYPES = frozenset({
    "MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP",
    "SHELL_BASED_SURFACE_MODEL",
})


# STEP 텍스트에서 솔리드마다 (PRODUCT 이름, 조립체 안 등장 횟수, 고유 정점 수)를 구한다.
# PRODUCT_DEFINITION_SHAPE에서 출발해 PRODUCT_DEFINITION → FORMATION → PRODUCT로 이름을,
# SHAPE_DEFINITION_REPRESENTATION → 형상 표현으로 솔리드를 찾는다.
# 반환: 이름이 있는 것만 [{name, occurrences, vertices}, ...]
def product_names_from_step(path: str):
    entities = _parse_step_entities(path)
    # 타입 이름 → 엔티티 번호 목록
    by_type = dict()
    for identifier, (kind, _) in entities.items():
        by_type.setdefault(kind, list()).append(identifier)

    # 여러 타입의 엔티티 번호를 한 목록으로 모은다.
    def of_type(*kinds):
        result = list()
        for kind in kinds:
            result.extend(by_type.get(kind, ()))
        return result

    # PRODUCT 번호 → 이름(비어 있지 않은 첫 문자열)
    product_name = dict()
    for identifier in of_type("PRODUCT"):
        values = [value for value in _entity_strings(entities[identifier][1]) if value.strip()]
        product_name[identifier] = values[0] if values else None

    # 참조를 따라갈 표: FORMATION → PRODUCT, DEFINITION → FORMATION,
    # DEFINITION_SHAPE → DEFINITION, DEFINITION_SHAPE → 형상 표현들
    product_of_formation = dict()
    for identifier in of_type("PRODUCT_DEFINITION_FORMATION",
                              "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE"):
        linked = _entity_references(entities[identifier][1])
        if linked:
            product_of_formation[identifier] = linked[0]

    formation_of_definition, definition_ids = dict(), set()
    for identifier in of_type("PRODUCT_DEFINITION"):
        definition_ids.add(identifier)
        linked = _entity_references(entities[identifier][1])
        if linked:
            formation_of_definition[identifier] = linked[0]

    definition_of_shape = dict()
    for identifier in of_type("PRODUCT_DEFINITION_SHAPE"):
        linked = _entity_references(entities[identifier][1])
        if linked:
            definition_of_shape[identifier] = linked[0]

    representation_of_shape = dict()
    for identifier in of_type("SHAPE_DEFINITION_REPRESENTATION"):
        linked = _entity_references(entities[identifier][1])
        if len(linked) >= 2:
            representation_of_shape.setdefault(linked[0], list()).append(linked[1])

    # 조립 배치용 관계(CONTEXT_DEPENDENT_SHAPE_REPRESENTATION)가 가리키는 관계는 빼고,
    # 나머지 표현 사이 관계를 양방향 연결로 저장한다.
    assembly_relations = set()
    for identifier in of_type("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION"):
        assembly_relations.update(_entity_references(entities[identifier][1]))
    geometry_links = dict()
    for identifier in of_type("SHAPE_REPRESENTATION_RELATIONSHIP",
                              "REPRESENTATION_RELATIONSHIP"):
        if identifier in assembly_relations:
            continue
        linked = _entity_references(entities[identifier][1])
        if len(linked) >= 2:
            geometry_links.setdefault(linked[0], set()).add(linked[1])
            geometry_links.setdefault(linked[1], set()).add(linked[0])

    # 표현과 거기 연결된 표현들을 따라가며 솔리드 엔티티 번호를 모은다(방문한 표현은 건너뛴다).
    def solids_in(representation_id, visited=None):
        if visited is None:
            visited = set()
        if representation_id in visited:
            return list()
        visited.add(representation_id)
        found = list()
        entry = entities.get(representation_id)
        if entry is not None:
            for item in _entity_references(entry[1]):
                candidate = entities.get(item)
                if candidate is not None and candidate[0] in _SOLID_ENTITY_TYPES:
                    found.append(item)
        for neighbour in geometry_links.get(representation_id, ()):
            found.extend(solids_in(neighbour, visited))
        return found

    # PRODUCT별 솔리드 엔티티 목록
    solids_of_product, product_of_definition = dict(), dict()
    for shape_id, definition_id in definition_of_shape.items():
        formation = formation_of_definition.get(definition_id)
        product = product_of_formation.get(formation) if formation is not None else None
        if product is None:
            continue
        product_of_definition[definition_id] = product
        for representation in representation_of_shape.get(shape_id, ()):
            solids_of_product.setdefault(product, list()).extend(solids_in(representation))

    # NEXT_ASSEMBLY_USAGE_OCCURRENCE로 부모 → 자식 정의 관계를 만들고,
    # 부모가 없는 정의를 루트로 둔다.
    children, child_definitions = dict(), set()
    for identifier in of_type("NEXT_ASSEMBLY_USAGE_OCCURRENCE"):
        linked = [value for value in _entity_references(entities[identifier][1])
                  if value in definition_ids]
        if len(linked) >= 2:
            children.setdefault(linked[0], list()).append(linked[1])
            child_definitions.add(linked[1])
    roots = [value for value in definition_ids if value not in child_definitions]

    # PRODUCT별 조립체 안 등장 횟수
    occurrences = dict()

    # 루트에서 조립 트리를 내려가며 등장 횟수를 센다(seen으로 순환을 막는다).
    def walk(definition_id, seen):
        product = product_of_definition.get(definition_id)
        if product is None:
            return
        occurrences[product] = occurrences.get(product, 0) + 1
        if definition_id in seen:
            return
        for child in children.get(definition_id, ()):
            walk(child, seen | {definition_id})

    for root in roots:
        walk(root, frozenset())

    # 솔리드 엔티티 아래의 VERTEX_POINT 좌표를 모아 고유 정점 수를 센다
    # (몸체와 이름을 맞출 때 쓰는 특징).
    def vertex_count(solid_id):
        seen, stack, points = set(), [solid_id], set()
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            entry = entities.get(current)
            if entry is None:
                continue
            kind, arguments = entry
            if kind == "VERTEX_POINT":
                for reference in _entity_references(arguments):
                    point = entities.get(reference)
                    if point is not None and point[0] == "CARTESIAN_POINT":
                        numbers = re.findall(r"-?\d+\.?\d*(?:[Ee][+-]?\d+)?",
                                             point[1].split("(", 1)[-1])
                        if len(numbers) >= 3:
                            points.add(tuple(round(float(value), 4) for value in numbers[:3]))
                continue
            if kind in ("CARTESIAN_POINT", "DIRECTION"):
                continue
            stack.extend(_entity_references(arguments))
        return len(points)

    # 솔리드마다 (이름, 등장 횟수, 정점 수)
    parts = list()
    for product, solids in solids_of_product.items():
        for solid in solids:
            parts.append(dict(name=product_name.get(product),
                              occurrences=occurrences.get(product, 1),
                              vertices=vertex_count(solid)))
    return [part for part in parts if part["name"]]


# 형상 안의 몸체를 모은다: 모든 SOLID(True)와 어느 SOLID에도 속하지 않는 SHELL(False).
# 반환: [(몸체, 솔리드 여부), ...]
def enumerate_bodies(shape) -> List[Tuple[object, bool]]:
    bodies: List[Tuple[object, bool]] = list()
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        bodies.append((topods.Solid(explorer.Current()), True))
        explorer.Next()

    shell_owners = TopTools_IndexedDataMapOfShapeListOfShape()
    topexp.MapShapesAndAncestors(shape, TopAbs_SHELL, TopAbs_SOLID, shell_owners)
    for index in range(1, shell_owners.Size() + 1):
        if shell_owners.FindFromIndex(index).Size() == 0:
            bodies.append((topods.Shell(shell_owners.FindKey(index)), False))
    return bodies


# 메쉬와 STEP 몸체를 짝짓지 못했을 때 발생시키는 예외
class StepMatchingException(Exception):
    pass


# 점들의 경계 상자 중심(3)과 크기(3)를 이은 6차원 특징
def _bounding_key(points: np.ndarray) -> np.ndarray:
    lower = points.min(axis=0)
    upper = points.max(axis=0)
    return np.concatenate([(lower + upper) / 2.0, upper - lower])


# 형상을 삼각분할해 모든 노드 좌표를 모은다(짝짓기 특징 계산용).
def _triangulated_points(shape) -> np.ndarray:
    breptools.Clean(shape)
    BRepMesh_IncrementalMesh(shape, 0.02, False, 0.5, True)
    collected: List[List[float]] = list()
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = topods.Face(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation(face, location)
        if triangulation is not None:
            transformation = location.Transformation()
            for node_index in range(1, triangulation.NbNodes() + 1):
                point = triangulation.Node(node_index).Transformed(transformation)
                collected.append([point.X(), point.Y(), point.Z()])
        explorer.Next()
    return np.asarray(collected, dtype=float)


# 메쉬 부품마다 STEP의 B-rep 몸체를 하나씩 짝짓는다. 반환: {부품 번호: B-rep 형상}
# 가장 나쁜 짝의 거리가 maximum_error를 넘으면 예외를 발생시킨다.
def match_solids_to_step(
    solid_vertices: Dict[int, np.ndarray], step_path: str, maximum_error: float
) -> Dict[int, object]:
    root = Compound.load_from_step(step_path).topods_shape()
    shapes = [shape for shape, _ in enumerate_bodies(root)]
    if len(shapes) < len(solid_vertices):
        raise StepMatchingException(
            f"STEP has {len(shapes)} bodies but {len(solid_vertices)} parts to match"
        )

    solid_ids = sorted(solid_vertices.keys())
    mesh_keys = {i: _bounding_key(solid_vertices[i]) for i in solid_ids}
    shape_keys = list()
    for shape in shapes:
        points = _triangulated_points(shape)
        shape_keys.append(_bounding_key(points) if len(points) else np.full(6, np.inf))

    # 부품 × 몸체 거리: 경계 상자 특징 차이의 최대 성분
    distances = np.array(
        [
            [float(np.abs(mesh_keys[i] - shape_keys[s]).max()) for s in range(len(shapes))]
            for i in solid_ids
        ]
    )
    # 거리가 작은 (부품, 몸체) 쌍부터 겹치지 않게 짝짓는다.
    candidates = sorted(
        (distances[row][shape_index], row, shape_index)
        for row in range(len(solid_ids))
        for shape_index in range(len(shapes))
    )
    used_rows: set = set()
    used_shapes: set = set()
    matched: Dict[int, object] = dict()
    worst = 0.0
    for distance, row, shape_index in candidates:
        if row in used_rows or shape_index in used_shapes:
            continue
        used_rows.add(row)
        used_shapes.add(shape_index)
        matched[solid_ids[row]] = shapes[shape_index]
        worst = max(worst, distance)
    if len(matched) != len(solid_ids):
        raise StepMatchingException(
            f"matched only {len(matched)} of {len(solid_ids)} parts to STEP solids"
        )
    if worst > maximum_error:
        raise StepMatchingException(
            f"worst solid match error {worst:.3f} exceeds {maximum_error} — "
            "the mesh-to-B-rep correspondence is unreliable"
        )
    return matched


# STEP 파일을 읽어 몸체마다 trimesh 메쉬와 이름을 만든다. face_tolerance와
# angle_tolerance는 OCC 삼각분할의 선형·각도 허용 오차, max_workers는 메쉬 변환 스레드 수다.
class STEPLoader:
    def __init__(self, filename: str, face_tolerance: float, angle_tolerance: float, max_workers: int):
        self.filename = filename
        self.face_tolerance = face_tolerance
        self.angle_tolerance = angle_tolerance
        self.max_workers = max_workers
        # 메쉬를 얻지 못한 몸체의 (이름, 이유)와 몸체별 이름 출처
        self.skipped_bodies: List[Tuple[str, str]] = list()
        self.name_sources: List = list()

    # 몸체 하나를 삼각분할해 trimesh 메쉬로 바꾼다. 삼각형이 하나도 없으면 None.
    def load(self, body):
        breptools.Clean(body)
        BRepMesh_IncrementalMesh(
            body, self.face_tolerance, False, self.angle_tolerance, True
        )

        vertices, faces, index_of_coordinate = list(), list(), dict()
        explorer = TopExp_Explorer(body, TopAbs_FACE)
        while explorer.More():
            face = topods.Face(explorer.Current())
            location = TopLoc_Location()
            triangulation = BRep_Tool.Triangulation(face, location)
            if triangulation is not None:
                transformation = location.Transformation()
                # 방향이 뒤집힌 면은 꼭짓점 순서를 바꿔 법선이 바깥을 향하게 한다.
                is_reversed = face.Orientation() == TopAbs_REVERSED
                local_indices = list()
                for node_number in range(1, triangulation.NbNodes() + 1):
                    point = triangulation.Node(node_number).Transformed(transformation)
                    # 소수 여섯째 자리까지 같은 좌표의 정점은 하나로 합친다.
                    coordinate = (round(point.X(), 6), round(point.Y(), 6), round(point.Z(), 6))
                    global_index = index_of_coordinate.get(coordinate)
                    if global_index is None:
                        global_index = len(vertices)
                        index_of_coordinate[coordinate] = global_index
                        vertices.append([point.X(), point.Y(), point.Z()])
                    local_indices.append(global_index)
                for triangle_number in range(1, triangulation.NbTriangles() + 1):
                    first, second, third = triangulation.Triangle(triangle_number).Get()
                    a = local_indices[first - 1]
                    b = local_indices[second - 1]
                    c = local_indices[third - 1]
                    if a == b or b == c or a == c:
                        continue
                    faces.append([a, c, b] if is_reversed else [a, b, c])
            explorer.Next()

        if len(vertices) == 0 or len(faces) == 0:
            return None
        return Trimesh(
            vertices=np.asarray(vertices, dtype=float),
            faces=np.asarray(faces, dtype=np.int64),
            process=False,
        )

    # 정점 좌표(소수 셋째 자리)를 정렬해 만든 md5의 앞 6자리.
    # 부품 서명, 중복 몸체 판별, 이름 대용으로 쓴다.
    @staticmethod
    def mesh_signature(vertices):
        array = np.round(np.asarray(vertices, dtype=float), 3)
        ordered = array[np.lexsort(array.T)]
        return hashlib.md5(ordered.tobytes()).hexdigest()[:6]

    # B-rep 형상 서명: (고유 정점 수, 경계 상자, 정렬한 정점 좌표의 md5).
    # OCC 이름표와 몸체를 맞출 때 쓴다.
    @staticmethod
    def _shape_signature(shape):
        points = list()
        explorer = TopExp_Explorer(shape, TopAbs_VERTEX)
        seen = set()
        while explorer.More():
            point = BRep_Tool.Pnt(topods.Vertex(explorer.Current()))
            coordinate = (round(point.X(), 4), round(point.Y(), 4), round(point.Z(), 4))
            if coordinate not in seen:
                seen.add(coordinate)
                points.append(coordinate)
            explorer.Next()
        if not points:
            return (0, None, None)
        array = np.asarray(points, dtype=float)
        ordered = np.round(array[np.lexsort(array.T)], 3)
        return (
            len(points),
            tuple(np.round(array.min(axis=0), 3).tolist())
            + tuple(np.round(array.max(axis=0), 3).tolist()),
            hashlib.md5(ordered.tobytes()).hexdigest(),
        )

    # OCC의 read_step_file_with_names_colors로 형상별 이름을 읽어 {형상 서명: [이름, ...]}을
    # 만든다. 읽기에 실패하면 빈 사전을 돌려준다.
    def names_by_signature(self):
        try:
            from OCC.Extend.DataExchange import read_step_file_with_names_colors

            # OCC 함수가 찍는 표준 출력은 버린다.
            with io.StringIO() as sink, contextlib.redirect_stdout(sink):
                table = read_step_file_with_names_colors(self.filename)
        except Exception:
            return dict()

        names = dict()
        for shape, information in table.items():
            name = information[0] if isinstance(information, (tuple, list)) else information
            if name is None:
                continue
            signature = self._shape_signature(shape)
            if signature[2] is None:
                continue
            names.setdefault(signature, list()).append(str(name))
        return names

    # 같은 몸체가 부피가 음수인(안팎이 뒤집힌) 표현으로 한 번 더 들어 있으면 음수 쪽을 뺀다.
    # 경계 상자 차이가 대각선의 relative_tolerance 이내이고 |부피| 차이가 5% 이내인
    # 양수 몸체를 짝으로 본다(양수 몸체 하나는 한 번만 짝짓는다).
    @staticmethod
    def _without_duplicate_representations(bodies, relative_tolerance: float = 0.01):
        from OCC.Core.Bnd import Bnd_Box
        from OCC.Core.BRepBndLib import brepbndlib
        from OCC.Core.BRepGProp import brepgprop
        from OCC.Core.GProp import GProp_GProps

        measured = list()
        for body, is_solid in bodies:
            properties = GProp_GProps()
            brepgprop.VolumeProperties(body, properties)
            box = Bnd_Box()
            brepbndlib.AddOptimal(body, box)
            x1, y1, z1, x2, y2, z2 = box.Get()
            measured.append(dict(volume=properties.Mass(),
                                 box=np.array([x1, y1, z1, x2, y2, z2], dtype=float)))

        dropped, consumed = set(), set()
        negatives = sorted((i for i, m in enumerate(measured) if m["volume"] < 0),
                           key=lambda i: measured[i]["volume"])
        for index in negatives:
            entry = measured[index]
            span = float(np.linalg.norm(entry["box"][3:] - entry["box"][:3]))
            threshold = max(1e-6, span * relative_tolerance)
            for other, candidate in enumerate(measured):
                if other == index or other in consumed or candidate["volume"] < 0:
                    continue
                if float(np.abs(candidate["box"] - entry["box"]).max()) > threshold:
                    continue
                if abs(abs(candidate["volume"]) - abs(entry["volume"])) > \
                        abs(entry["volume"]) * 0.05:
                    continue
                dropped.add(index)
                consumed.add(other)
                break
        if not dropped:
            return bodies
        return [body for index, body in enumerate(bodies) if index not in dropped]

    # 이동·회전해도 변하지 않는 서명: (고유 정점 수, |부피|, 겉넓이). 같은 부품의 사본을 묶는다.
    @staticmethod
    def _rigid_signature(shape):
        from OCC.Core.BRepGProp import brepgprop
        from OCC.Core.GProp import GProp_GProps

        points, seen = 0, set()
        explorer = TopExp_Explorer(shape, TopAbs_VERTEX)
        while explorer.More():
            point = BRep_Tool.Pnt(topods.Vertex(explorer.Current()))
            coordinate = (round(point.X(), 4), round(point.Y(), 4), round(point.Z(), 4))
            if coordinate not in seen:
                seen.add(coordinate)
                points += 1
            explorer.Next()
        volume_properties = GProp_GProps()
        brepgprop.VolumeProperties(shape, volume_properties)
        surface_properties = GProp_GProps()
        brepgprop.SurfaceProperties(shape, surface_properties)
        return (points, round(abs(volume_properties.Mass()), 2),
                round(surface_properties.Mass(), 2))

    # 몸체에 STEP PRODUCT 이름을 붙인다. 강체 서명으로 몸체를 묶고, 정점 수 순으로 정렬한
    # PRODUCT 목록과 묶음을 차례로 맞대어 등장 횟수가 같을 때만 이름을 준다.
    # 사본이 여러 개면 무게 중심 순으로 '#1', '#2', …를 붙인다. STEP 파싱에 실패하면 모두 None.
    def _product_names_for_bodies(self, bodies):
        from OCC.Core.BRepGProp import brepgprop
        from OCC.Core.GProp import GProp_GProps

        try:
            parts = product_names_from_step(self.filename)
        except Exception:
            return [None] * len(bodies)
        if not parts:
            return [None] * len(bodies)

        # 강체 서명이 같은 몸체끼리 묶는다.
        groups = dict()
        for index, entry in enumerate(bodies):
            groups.setdefault(self._rigid_signature(entry[0]), list()).append(index)

        sorted_parts = sorted(parts, key=lambda part: (part["vertices"], part["name"]))
        sorted_groups = sorted(groups.items(), key=lambda item: (item[0][0], -len(item[1])))

        # 몸체의 무게 중심(사본 번호를 매기는 순서)
        def centre_of(index):
            properties = GProp_GProps()
            brepgprop.VolumeProperties(bodies[index][0], properties)
            point = properties.CentreOfMass()
            return (round(point.X(), 3), round(point.Y(), 3), round(point.Z(), 3))

        assigned = [None] * len(bodies)
        position = 0
        for _, members in sorted_groups:
            if position >= len(sorted_parts):
                break
            candidate = sorted_parts[position]
            if candidate["occurrences"] != len(members):
                position += len(members)
                continue
            for order, index in enumerate(sorted(members, key=centre_of), start=1):
                assigned[index] = (f"{candidate['name']}#{order}" if len(members) > 1
                                   else candidate["name"])
            position += 1
        return assigned

    # STEP을 읽어 (몸체, 솔리드 여부, 이름) 목록을 만든다.
    # 이름 우선순위: STEP PRODUCT 이름 → OCC 이름표(형상 서명으로 매칭) → None
    def bodies(self):
        shape = Compound.load_from_step(self.filename).topods_shape()
        self.name_sources = list()

        bodies = self._without_duplicate_representations(enumerate_bodies(shape))

        product_names = self._product_names_for_bodies(bodies)

        names_by_signature = self.names_by_signature()
        assigned = dict()
        named_bodies = list()
        for position, (body, is_solid) in enumerate(bodies):
            name = product_names[position]
            source = "product" if name is not None else None
            if name is None:
                signature = self._shape_signature(body)
                candidates = names_by_signature.get(signature)
                if candidates:
                    # 같은 서명의 이름 후보는 나온 순서대로 하나씩 쓰고,
                    # 다 쓰면 마지막 이름을 다시 쓴다.
                    consumed = assigned.get(signature, 0)
                    if consumed < len(candidates):
                        name = candidates[consumed]
                        assigned[signature] = consumed + 1
                    else:
                        name = candidates[-1]
                    source = "occ"
            named_bodies.append((body, is_solid, name, source))

        # 같은 이름이 여러 번 나오면 '#번호'를 붙여 구분한다.
        occurrence_count = dict()
        for _, _, name, _ in named_bodies:
            if name is not None:
                occurrence_count[name] = occurrence_count.get(name, 0) + 1
        used = dict()
        distinguished = list()
        for body, is_solid, name, source in named_bodies:
            if name is not None and occurrence_count[name] > 1:
                used[name] = used.get(name, 0) + 1
                name = f"{name}#{used[name]}"
            distinguished.append((body, is_solid, name))
            self.name_sources.append(source)
        return distinguished

    # 모든 몸체를 스레드 풀로 메쉬로 바꾼다. metadata에 솔리드 여부, 이름, 이름 출처를 담고,
    # 이름이 없으면 메쉬 서명을 이름으로 쓴다. 결과 목록은 변환이 끝난 순서대로 쌓인다.
    def load_all(self):
        trimeshes = list()
        collected = self.bodies()
        sources = list(self.name_sources) or [None] * len(collected)
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {
                executor.submit(self.load, body): (is_solid, name, sources[position])
                for position, (body, is_solid, name) in enumerate(collected)
            }
            for future in as_completed(futures):
                mesh = future.result()
                is_solid, name, source = futures[future]
                # 삼각분할 결과가 비면 이유를 남기고 건너뛴다.
                if mesh is None:
                    self.skipped_bodies.append(
                        (name if name is not None else "이름 없음",
                         "삼각분할 결과가 비었다 (면이 하나도 삼각분할되지 않음)")
                    )
                    continue
                mesh.metadata["is_solid"] = is_solid
                mesh.metadata["name_source"] = source if name is not None else "hash"
                mesh.metadata["name_from_step"] = name is not None
                mesh.metadata["name"] = (
                    name if name is not None else self.mesh_signature(mesh.vertices)
                )
                trimeshes.append(mesh)

        # 같은 이름이 여러 개면 '#번호'를 붙인다.
        counts = dict()
        for mesh in trimeshes:
            label = mesh.metadata["name"]
            counts[label] = counts.get(label, 0) + 1
        used = dict()
        for mesh in trimeshes:
            label = mesh.metadata["name"]
            if counts[label] > 1:
                used[label] = used.get(label, 0) + 1
                mesh.metadata["name"] = f"{label}#{used[label]}"

        return trimeshes
