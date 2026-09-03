"""STEP 입출력 — 몸체 열거·메쉬 변환·이름 부여, 그리고 B-rep 대응.

두 방향의 읽기를 담는다. 앞쪽은 STEP -> 삼각형 메쉬(STEPLoader)이고, 뒤쪽은 그 메쉬를
원본 STEP 의 B-rep 몸체에 되짚는 대응(match_solids_to_step)이다. 판정기가 B-rep 을
받으므로 두 경로가 모두 필요하고, 둘 다 enumerate_bodies 의 같은 열거 규칙을 써야 한다.
"""
import contextlib
import hashlib
import io
import re

from typing import Dict, List, Tuple

import numpy as np
from concurrent.futures import ThreadPoolExecutor
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


def _split_top_level(text: str, separator: str) -> List[str]:
    """따옴표와 괄호를 존중하며 최상위에서만 자른다.

    STEP 인자에는 문자열(작은따옴표, '' 로 이스케이프)과 중첩 괄호가 섞여 있으므로
    단순 split 으로는 자를 수 없다.
    """
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


def _parse_step_entities(path: str):
    """STEP 파일의 DATA 절을 {번호: (엔티티명, 인자문자열)} 로 읽는다."""
    with open(path, "r", errors="replace") as handle:
        text = handle.read()
    upper = text.upper()
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
        named = re.match(r"([A-Za-z0-9_]+)\s*\(", rest)
        if named is None:
            entities[int(head.group(1))] = ("__COMPLEX__", rest)
            continue
        entities[int(head.group(1))] = (
            named.group(1).upper(),
            rest[named.end():-1] if rest.endswith(")") else rest[named.end():],
        )
    return entities


def _entity_references(argument_text: str) -> List[int]:
    return [int(value) for value in re.findall(r"#(\d+)", argument_text)]


def _entity_strings(argument_text: str) -> List[str]:
    return [match.group(1).replace("''", "'")
            for match in re.finditer(r"'((?:[^']|'')*)'", argument_text)]


_SOLID_ENTITY_TYPES = frozenset({
    "MANIFOLD_SOLID_BREP", "BREP_WITH_VOIDS", "FACETED_BREP",
    "SHELL_BASED_SURFACE_MODEL",
})


def product_names_from_step(path: str):
    """STEP 텍스트에서 (PRODUCT 이름, 배치 횟수, B-rep 정점 수) 목록을 얻는다.

    텍스트를 직접 파싱하는 이유: pythonocc 의 read_step_file_with_names_colors 가 PRODUCT
    이름을 주지 못하는 파일이 있다(as1-oc-214-both 는 'SOLID' 하나만 돌려주어 18 몸체가
    전부 SOLID#n 이 된다). 정공법인 XDE 는 이 빌드에서 쓸 수 없다 — TDocStd_Document
    생성자가 SIGABRT 로 프로세스를 죽이고, NewDocument 는 요구하는 핸들을 얻을 수 없으며,
    Transfer_TransientProcess 는 하위 기하만 대응해 SOLID 가 없다.

    체인은 AP203/AP214 표준을 따른다.

        PRODUCT('id','name',...)                   <- 이름
          ^ PRODUCT_DEFINITION_FORMATION
            ^ PRODUCT_DEFINITION                   <- NAUO 가 잇는 노드
              ^ PRODUCT_DEFINITION_SHAPE
                ^ SHAPE_DEFINITION_REPRESENTATION
                  -> SHAPE_REPRESENTATION(items 에 SOLID)

    이름은 '비어 있지 않은 첫 문자열' 을 쓴다 — CHP-260L 이 첫째 인자에 품번을 넣고 name
    을 비우므로 표준 위치로 고정할 수 없다.

    Returns:
        [{name, occurrences, vertices}, ...]. SOLID 를 가진 PRODUCT 만 담기며, multi-body
        PRODUCT 는 항목이 여러 개 나온다.
    """
    entities = _parse_step_entities(path)
    by_type = dict()
    for identifier, (kind, _) in entities.items():
        by_type.setdefault(kind, list()).append(identifier)

    def of_type(*kinds):
        result = list()
        for kind in kinds:
            result.extend(by_type.get(kind, ()))
        return result

    product_name = dict()
    for identifier in of_type("PRODUCT"):
        values = [value for value in _entity_strings(entities[identifier][1]) if value.strip()]
        product_name[identifier] = values[0] if values else None

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

    # 조립 배치용 관계와 '같은 부품의 다른 표현' 관계를 가른다. 전자를 기하 연결로
    # 착각하면 한 부품이 다른 부품의 SOLID 를 자기 것으로 셈한다.
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

    solids_of_product, product_of_definition = dict(), dict()
    for shape_id, definition_id in definition_of_shape.items():
        formation = formation_of_definition.get(definition_id)
        product = product_of_formation.get(formation) if formation is not None else None
        if product is None:
            continue
        product_of_definition[definition_id] = product
        for representation in representation_of_shape.get(shape_id, ()):
            solids_of_product.setdefault(product, list()).extend(solids_in(representation))

    children, child_definitions = dict(), set()
    for identifier in of_type("NEXT_ASSEMBLY_USAGE_OCCURRENCE"):
        linked = [value for value in _entity_references(entities[identifier][1])
                  if value in definition_ids]
        if len(linked) >= 2:
            children.setdefault(linked[0], list()).append(linked[1])
            child_definitions.add(linked[1])
    roots = [value for value in definition_ids if value not in child_definitions]

    occurrences = dict()

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

    parts = list()
    for product, solids in solids_of_product.items():
        for solid in solids:
            parts.append(dict(name=product_name.get(product),
                              occurrences=occurrences.get(product, 1),
                              vertices=vertex_count(solid)))
    return [part for part in parts if part["name"]]


def enumerate_bodies(shape) -> List[Tuple[object, bool]]:
    """몸체를 열거한다 — SOLID 전부 + 어떤 SOLID 에도 속하지 않는 자유 SHELL.

    SOLID 안에 든 SHELL 은 그 SOLID 가 이미 담고 있으므로 제외한다. 그러지 않으면 같은
    표면이 두 번 들어가 부품이 중복된다. STEP 은 두께 있는 벽을 열린
    SHELL(SHELL_BASED_SURFACE_MODEL)로 저장하기도 하므로 SOLID 만 훑으면 몸체가 빠진다
    (Hair Dryer.STEP 의 배럴 하우징이 그 예로, 16 개만 읽히고 내부 팬·모터가 드러났다).

    로더와 B-rep 대응(match_solids_to_step)이 같은 규칙을 써야 한다 — 어긋나면 자유
    SHELL 을 가진 파일에서 전수 대응이 실패한다.

    Args:
        shape: 루트 TopoDS_Shape.

    Returns:
        (TopoDS_Shape, is_solid) 목록.
    """
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


class StepMatchingException(Exception):
    """메쉬를 원본 STEP 의 B-rep 몸체에 대응시키지 못했을 때."""


def _bounding_key(points: np.ndarray) -> np.ndarray:
    """정점 집합의 (중심, 크기) 6-벡터. 강체 배치가 같은 형상끼리 대응시키는 키."""
    lower = points.min(axis=0)
    upper = points.max(axis=0)
    return np.concatenate([(lower + upper) / 2.0, upper - lower])


def _triangulated_points(shape) -> np.ndarray:
    """B-rep 몸체를 삼각분할해 정점을 모은다.

    OCC 의 Bnd_Box 는 곡면에 대해 보수적으로 부풀린 상자를 주므로(실측 오차 최대 82.96)
    메쉬와의 대응에 쓸 수 없다. 삼각분할 정점으로 직접 상자를 계산해야 정확히 대응된다.
    """
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


def match_solids_to_step(
    solid_vertices: Dict[int, np.ndarray], step_path: str, maximum_error: float
) -> Dict[int, object]:
    """부품 식별자 -> 원본 STEP 의 B-rep 몸체 대응을 만든다.

    판정기(core.interference)는 B-rep 몸체를 받아 스스로 삼각분할한다. 그런데 부품
    식별자는 로더의 열거 순서에서 오고 그 순서는 비결정적이므로 정수 인덱스로는 두
    경로(로더 메쉬 / B-rep 몸체)를 짝지을 수 없다. 그래서 형상으로 대응시킨다 —
    삼각분할 정점의 (중심, 크기) 키를 전역 그리디로 1:1 대응시킨다.

    전수 대응에 실패하면 예외를 던진다 — 부분 대응으로 얻은 판정은 신뢰할 수 없다
    (실측: 13 개 중 5 개만 대응됐을 때 심판 결과가 정반대로 나왔다).

    Args:
        solid_vertices: 부품 식별자 -> 월드 좌표계 정점 배열 (N, 3).
        step_path: 원본 STEP 파일 경로.
        maximum_error: 허용 대응 오차(키 성분 최대 차이).

    Returns:
        부품 식별자 -> TopoDS_Shape.

    Raises:
        StepMatchingException: 전수 대응에 실패하거나 오차가 상한을 넘으면.
    """
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

    distances = np.array(
        [
            [float(np.abs(mesh_keys[i] - shape_keys[s]).max()) for s in range(len(shapes))]
            for i in solid_ids
        ]
    )
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


class STEPLoader:
    """STEP 의 모든 몸체를 삼각형 메쉬로 변환한다.

    compound.solids() 만 훑는 방식은 세 가지 결함이 있어(전부 실측) 직접 구현한다.

    1. 몸체 누락 — SHELL_BASED_SURFACE_MODEL(열린 SHELL)로 저장된 몸체가 통째로 빠진다.
       Hair Dryer.STEP 의 배럴 하우징(면 14 개, 크기 191x103x71)이 그 예로, 16 개만
       읽혀 내부 팬과 모터가 드러났고 판정에서도 장애물 하나가 빠진 상태였다.
    2. 거친 삼각분할 — occwl 은 isRelative=True 로 부르므로 face_tolerance 가 면 크기에
       대한 비율이 되어 큰 면일수록 실제 허용오차가 커진다(같은 인자에서 절대 22,942
       삼각형 vs 상대 1,166, 부피비 0.9992 vs 0.9729). 충돌 판정은 형상 정확도에
       직결되므로 절대 허용오차를 쓴다.
    3. 위상 단절과 뒤집힌 법선 — 면마다 정점을 새로 쌓아 인접 면이 이어지지 않고(중복률
       0.0%) REVERSED 방향을 반영하지 않아 일부 삼각형이 안쪽을 향한다. 좌표로 전역
       병합하고 winding 을 맞추면 해소된다.

    STEP 의 이름-형상 구조
    ---------------------
    이름은 PRODUCT 에 붙고 그 아래 SOLID 들이 달린다:

        PRODUCT('id','name',...)                   <- 이름이 붙는 곳
          ^ PRODUCT_DEFINITION_FORMATION
            ^ PRODUCT_DEFINITION                   <- 조립 트리(NAUO)가 잇는 노드
              ^ PRODUCT_DEFINITION_SHAPE
                ^ SHAPE_DEFINITION_REPRESENTATION
                  -> SHAPE_REPRESENTATION(items)   <- items 안에 SOLID 들

    'PRODUCT 1 개 = SOLID 1 개' 가 아니다(전부 실측):
      (1) 조립 노드 — SOLID 를 직접 갖지 않고 자식 PRODUCT 만 가리킨다(Coway D4P 40 중 10).
      (2) 인스턴싱 — 같은 PRODUCT 가 여러 번 배치된다(as1 의 nut 8 번). 접미사 #1, #2 로
          구분하며 순서는 월드 무게중심 사전식이라 실행 간 안정하다.
      (3) multi-body — 한 PRODUCT 의 representation 이 SOLID 를 여럿 담는다(CHP-260L 의
          와이어 하네스 139 개). 실무에서 흔한 구조이며 오류가 아니다.

    이름이 놓이는 인자는 파일마다 다르다 — 표준은 PRODUCT(id, name, ...) 이지만 CHP-260L
    은 첫째에 품번을 넣고 name 을 비운다. 그래서 필드 위치로 고정할 수 없고, pythonocc 의
    read_step_file_with_names_colors 를 쓰되 얻지 못하면 형상 해시로 대체한다(name 은 항상
    존재한다). as1 처럼 pythonocc 가 'SOLID' 하나만 돌려주는 파일에서 폴백이 작동한다.

    라이브러리를 바꾸지 않는 이유(3 종 시험): gmsh 최선 설정이 부피오차 중앙 0.317% /
    최대 7.556% 로 이 구현(0.077% / 2.704%)보다 나쁘면서 삼각형 4 배·시간 10 배를 쓰고
    Cleaner-upperbody 에서 실패한다. Netgen 은 Cleaner-hip 표면 메쉬 생성 자체가 실패한다
    (구멍 322). gmsh 의 장점은 봉합뿐이고 구멍은 core.interference 의 복구 절차가 닫는다
    (29/29 성공). 기각된 gmsh 크기 규칙 — 기본값, 대각선 비례 D/80, 표면적 비례, 곡률
    적응, 편차 공식 h=sqrt(8Rd).
    """

    def __init__(self, filename: str, face_tolerance: float, angle_tolerance: float, max_workers: int):
        self.filename = filename
        self.face_tolerance = face_tolerance
        self.angle_tolerance = angle_tolerance
        self.max_workers = max_workers
        # 메쉬로 만들지 못한 몸체: (이름, 사유). load_all 이 채운다. 호출자가 msgpack
        # 메타데이터에 남겨 '몸체 수가 줄었다' 는 사실을 드러내야 한다.
        self.skipped_bodies: List[Tuple[str, str]] = list()
        # 이름의 출처: bodies() 순서대로 "product" | "occ" | None(=해시 폴백 대상).
        # 호출자가 metadata 에 남겨야 한다 — 'SOLID#3' 같은 무의미한 이름을 STEP 이름으로
        # 오독하지 않게 하려면 이름 자체가 아니라 출처를 봐야 한다.
        self.name_sources: List = list()

    def load(self, body):
        """TopoDS 몸체(SOLID 또는 SHELL)를 위상이 이어진 메쉬로 변환한다.

        Args:
            body: TopoDS_Shape — SOLID 또는 자유 SHELL.

        Returns:
            Trimesh. 삼각분할된 면이 하나도 없으면 None.
        """
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
                is_reversed = face.Orientation() == TopAbs_REVERSED
                local_indices = list()
                for node_number in range(1, triangulation.NbNodes() + 1):
                    point = triangulation.Node(node_number).Transformed(transformation)
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

    @staticmethod
    def mesh_signature(vertices):
        """삼각분할된 메쉬의 정점 좌표로 부품 식별자를 만든다.

        좌표를 3자리로 반올림한 뒤 사전식 정렬해 해싱하므로, 정점 배열의 순서가
        달라도 값이 같다 — load_all 이 완료 순서로 메쉬를 돌려주고 면 순회 순서도
        보장되지 않으므로 순서 불변성이 필요하다.

        이름을 얻지 못한 부품의 대체 이름이자 msgpack 의 signature 필드로 쓰인다.
        두 곳이 같은 값이어야 하므로 산출을 여기 한 곳에 둔다.

        Args:
            vertices: (N, 3) 정점 좌표 배열.

        Returns:
            16진 6자리 문자열.
        """
        array = np.round(np.asarray(vertices, dtype=float), 3)
        ordered = array[np.lexsort(array.T)]
        return hashlib.md5(ordered.tobytes()).hexdigest()[:6]

    @staticmethod
    def _shape_signature(shape):
        """몸체를 실행 간 안정적으로 식별하는 기하 서명.

        B-rep 정점(TopAbs_VERTEX)의 좌표만 쓴다. 삼각분할을 거치지 않으므로 값이
        허용오차 설정과 무관하고, OCC 의 경계상자 헬퍼도 쓰지 않는다 — 그 헬퍼는
        곡면에서 상자를 부풀리므로 같은 형상을 두 경로로 읽었을 때 값이 어긋난다.

        정점 개수와 경계상자만으로는 '같은 상자에 든 다른 형상'을 구분하지 못해 이름이
        엉뚱한 부품에 붙을 수 있으므로, 정렬한 전체 좌표의 해시까지 넣는다. 정렬하는
        이유는 두 읽기 경로가 정점을 같은 순서로 준다는 보장이 없기 때문이다.

        Returns:
            (정점 개수, 반올림한 최소·최대 좌표, 좌표 해시) 튜플. 정점이 없으면
            (0, None, None).
        """
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

    def names_by_signature(self):
        """STEP 에 저장된 부품 이름을 기하 서명별로 돌려준다.

        부품 번호는 load_all 의 완료 순서에 묶여 실행마다 달라지므로 번호로는 이름을
        붙일 수 없다. 대신 몸체의 B-rep 정점 서명을 키로 쓴다.

        이름은 pythonocc 의 read_step_file_with_names_colors 로 읽는다. XDE 문서를
        직접 만드는 경로(TDocStd_Document 생성자)는 이 빌드에서 Standard_NullObject 로
        프로세스를 죽이므로 쓰지 않는다.

        Returns:
            서명 -> 이름 목록. 같은 부품이 여러 번 배치되면 서명이 같고 이름도 같으므로
            목록에 중복해 담긴다. 이름을 읽지 못하면 빈 딕셔너리.
        """
        try:
            from OCC.Extend.DataExchange import read_step_file_with_names_colors

            # 이 함수는 몸체·색상마다 print 를 찍는다(as1 18부품에서 261줄). 진행 상황이
            # 아니라 라이브러리 내부 잡음이므로 삼킨다.
            with io.StringIO() as sink, contextlib.redirect_stdout(sink):
                table = read_step_file_with_names_colors(self.filename)
        except Exception:
            # 이름은 부가 정보다 — 못 읽어도 기하 처리는 그대로 진행한다.
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

    @staticmethod
    def _without_duplicate_representations(bodies, relative_tolerance: float = 0.01):
        """같은 부품을 두 번 담은 STEP 에서 한 벌만 남긴다.

        AP203 과 AP214 표현을 한 파일에 저장하면 같은 부품이 방향만 반대인 두 몸체로
        들어온다(as1-oc-214-both: 몸체 36 개, 부피 분포가 음수 18 / 양수 18 로 대칭이며
        경계상자가 쌍으로 일치). 같은 자리에 두 몸체가 있으면 서로 100% 간섭이므로 강체
        분해가 원리적으로 불가능해진다.

        기존 중복 제거로는 안 걸린다 — IsPartner/IsSame 은 별개 TShape 이라 걸리지 않고,
        형상 해시는 방향이 반대라 정점 순서와 winding 이 달라 값이 다르다.

        '음수 부피면 버린다' 로 하지 않는 이유(오탐 실측): CHP-470L 의 음수 부피 몸체
        하나는 같은 자리에 짝이 없는 정상 부품이라 버리면 부품이 사라진다. 그래서 조건을
        '짝의 존재' 로 둔다 — 경계상자가 일치하고 부피 절댓값이 5% 안에서 같은 반대 부호
        몸체가 있을 때만 음수 쪽을 버린다.

        Args:
            bodies: (TopoDS_Shape, is_solid) 목록.
            relative_tolerance: 경계상자 일치 판정에 쓸 몸체 대각선 대비 비율.

        Returns:
            중복 표현을 뺀 (TopoDS_Shape, is_solid) 목록. 순서는 유지된다.
        """
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

    @staticmethod
    def _rigid_signature(shape):
        """강체운동에 불변인 형상 서명 — 배치 변환이 달라도 같은 값이다.

        (B-rep 정점 개수, 부피 절댓값, 표면적). 좌표 자체를 쓸 수 없는 이유는 조립
        배치 변환이 인스턴스마다 좌표를 옮기기 때문이다(실측: as1 의 nut 8 개가 전부
        다른 위치). 좌표 해시로 텍스트와 대조하는 것도 불가능하다 — OCC 의 STEP 리더가
        읽는 동안 형상을 치유해 정점 수가 달라진다(실측: Cleaner-bottom body 텍스트
        1488 vs OCC 1508, as1 bolt 10 vs 8).
        """
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

    def _product_names_for_bodies(self, bodies):
        """텍스트 체인에서 얻은 PRODUCT 이름을 몸체에 배정한다.

        좌표로 대조할 수 없다(OCC 리더의 치유와 배치 변환이 좌표를 바꾼다). 그래서 강체
        서명으로 몸체를 그룹화하고 텍스트 항목을 정점 수 순위로 짝짓는다 — 순위는 치유에도
        보존된다(as1: rod 4 < bolt 10|8 < nut 12 < l-bracket 28 < plate 32).

        채택 조건은 '그룹 크기 == 배치 횟수' 이고, 어긋나는 그룹은 배정하지 않는다. Hair
        Dryer 의 lead 와 lead2 는 정점·면·부피·면적·관성까지 동일한 '이름만 다른 동일
        형상' 이라 기하로 결정할 수 없다 — 틀린 이름은 이름 없는 것보다 나쁘므로 pythonocc
        경로에 맡긴다.

        인스턴스 접미사는 월드 무게중심의 사전식 순서로 매긴다. 로더의 완료 순서는 실행마다
        #1 과 #2 가 뒤바뀔 수 있으나 좌표는 그렇지 않다.

        Returns:
            몸체 목록과 같은 길이의 이름 목록. 배정하지 못한 자리는 None.
        """
        from OCC.Core.BRepGProp import brepgprop
        from OCC.Core.GProp import GProp_GProps

        try:
            parts = product_names_from_step(self.filename)
        except Exception:
            # 이름은 부가 정보다 — 파싱이 실패해도 기하 처리는 그대로 진행한다.
            return [None] * len(bodies)
        if not parts:
            return [None] * len(bodies)

        # bodies 는 (몸체, is_solid) 2-튜플 목록이다 — bodies() 가 이름을 붙이기 전에
        # 이 메서드를 부르므로 이름 자리가 아직 없다.
        groups = dict()
        for index, entry in enumerate(bodies):
            groups.setdefault(self._rigid_signature(entry[0]), list()).append(index)

        sorted_parts = sorted(parts, key=lambda part: (part["vertices"], part["name"]))
        sorted_groups = sorted(groups.items(), key=lambda item: (item[0][0], -len(item[1])))

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
                # 동일 형상에 이름이 여럿이거나 대응이 어긋난 그룹 — 건너뛴다.
                position += len(members)
                continue
            for order, index in enumerate(sorted(members, key=centre_of), start=1):
                assigned[index] = (f"{candidate['name']}#{order}" if len(members) > 1
                                   else candidate["name"])
            position += 1
        return assigned

    def bodies(self):
        """메쉬로 변환할 모든 몸체를 돌려준다 — SOLID 전부 + 어떤 SOLID 에도 속하지 않는 SHELL.

        SOLID 안에 든 SHELL 은 그 SOLID 가 이미 담고 있으므로 제외한다. 그러지 않으면
        같은 표면이 두 번 들어가 부품이 중복된다.

        Returns:
            (TopoDS_Shape, is_solid, name) 목록. is_solid 가 False 면 자유 SHELL 이고,
            name 은 STEP 에서 이름을 얻지 못했으면 None 이다. 같은 이름이 여러 몸체에
            걸리면(같은 부품이 여러 번 배치) '이름#1', '이름#2' 로 구분한다.
        """
        shape = Compound.load_from_step(self.filename).topods_shape()
        self.name_sources = list()

        bodies = self._without_duplicate_representations(enumerate_bodies(shape))

        # 이름 부여: 계층 1(PRODUCT 체인) -> 계층 2(pythonocc). 계층 1 이 앞서는 것은
        # pythonocc 가 이름을 주지 못하는 파일이 있기 때문이고(as1 은 'SOLID' 하나만),
        # 계층 2 를 남기는 것은 계층 1 이 배정할 수 없는 경우가 있기 때문이다(형상이 같은
        # lead/lead2). 음성 대조: 계층 1 배정 이름이 세 파일에서 pythonocc 와 일치한다.
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
                    # 같은 서명에 이름이 여러 개면 순서대로 하나씩 소비한다(같은 부품이
                    # 여러 번 배치된 경우이므로 이름이 서로 같다).
                    consumed = assigned.get(signature, 0)
                    if consumed < len(candidates):
                        name = candidates[consumed]
                        assigned[signature] = consumed + 1
                    else:
                        name = candidates[-1]
                    source = "occ"
            named_bodies.append((body, is_solid, name, source))

        # 같은 이름이 둘 이상이면(같은 부품이 여러 번 배치) 접미사로 구분한다.
        # 계층 1 이 붙인 이름에는 이미 위치 기준 접미사가 있으므로 여기서 다시 붙지 않는다.
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

    def load_all(self):
        """모든 몸체를 메쉬로 변환해 돌려준다.

        각 메쉬에 metadata['is_solid'] 와 metadata['name'] 을 단다.

        is_solid 가 False 면 자유 SHELL 이다. 두께 없는 서피스라 부피가 정의되지 않으므로
        판정에 쓸 수 없다 — 닫으면 속 빈 껍질이 아니라 그 공간을 채운 덩어리가 되어(배럴
        하우징 부피 85,396) 안에 든 팬·모터가 100% 간섭이 된다. 호출자는 시각화에만 쓰고
        판정 대상에서 제외해야 한다.

        name 은 STEP 의 부품 이름이며 얻지 못하면 형상 해시를 쓴다(mesh_signature). 따라서
        항상 존재하고 호출자가 None 을 다룰 필요가 없다. 해시로 대체된 부품은
        metadata['name_from_step'] 이 False 다.

        이름을 얻지 못하는 조건은 넷이다 — 읽기 예외, STEP 이름 항목이 빔, B-rep 정점 없음,
        두 읽기 경로의 기하 서명 불일치(마지막이 실질적 위험이며 multi-body PRODUCT 나
        배치 변환 차이에서 생긴다).

        반환 순서는 bodies() 제출 순서를 유지한다.
        """
        trimeshes = list()
        collected = self.bodies()
        sources = list(self.name_sources) or [None] * len(collected)
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            # as_completed 대신 제출 순서를 유지해 part_index = bodies() 순번이 되게 한다.
            future_entries = [
                (
                    executor.submit(self.load, body),
                    is_solid,
                    name,
                    sources[position],
                )
                for position, (body, is_solid, name) in enumerate(collected)
            ]
            for future, is_solid, name, source in future_entries:
                mesh = future.result()
                if mesh is None:
                    # 삼각분할이 아무 면도 내지 못한 몸체다. 조용히 버리면 부품 수가 줄어든
                    # 것을 아무도 모르므로 기록한다 — 호출자가 이 목록을 msgpack 에 남겨
                    # '변환 실패' 를 드러내야 한다.
                    self.skipped_bodies.append(
                        (name if name is not None else "이름 없음",
                         "삼각분할 결과가 비었다 (면이 하나도 삼각분할되지 않음)")
                    )
                    continue
                mesh.metadata["is_solid"] = is_solid
                mesh.metadata["name_source"] = source if name is not None else "hash"
                # 하위 호환 — 기존 호출자가 이 키를 읽는다. 다만 이 값만 보면 as1 의
                # 'SOLID#3' 처럼 무의미한 이름도 True 가 되므로 name_source 를 써야 한다.
                mesh.metadata["name_from_step"] = name is not None
                mesh.metadata["name"] = (
                    name if name is not None else self.mesh_signature(mesh.vertices)
                )
                trimeshes.append(mesh)

        # 해시로 대체한 이름이 STEP 이름과 우연히 겹치면 두 부품이 같은 이름이 된다.
        # 6자리 16진수와 사람이 붙인 이름이 겹칠 일은 사실상 없지만, 겹치면 조용히
        # 잘못된 대응이 되므로 접미사를 붙여 드러낸다.
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
