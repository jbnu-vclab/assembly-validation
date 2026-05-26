import * as THREE from 'three'

/**
 * @typedef {{ origin: number[], voxelSize: number, resolution: number[] | null }} GridMeta
 */

export function parseNpyHeader(headerText) {
	const shapeMatch = headerText.match(/'shape':\s*\(([^)]*)\)/)
	const descrMatch = headerText.match(/'descr':\s*'([^']+)'/)
	const fortranMatch = headerText.match(/'fortran_order':\s*(True|False)/)
	if (!shapeMatch || !descrMatch || !fortranMatch) {
		throw new Error('Invalid npy header format.')
	}

	const shape = shapeMatch[1]
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.map((s) => Number(s))

	const descr = descrMatch[1]
	const fortranOrder = fortranMatch[1] === 'True'
	return { shape, descr, fortranOrder }
}

export function parseNpyArrayBuffer(buffer) {
	const view = new DataView(buffer)
	const magic = String.fromCharCode(
		view.getUint8(0),
		view.getUint8(1),
		view.getUint8(2),
		view.getUint8(3),
		view.getUint8(4),
		view.getUint8(5)
	)
	if (magic !== '\x93NUMPY') {
		throw new Error('Not a valid .npy file.')
	}

	const major = view.getUint8(6)
	const minor = view.getUint8(7)
	let headerLen = 0
	let dataOffset = 0

	if (major === 1) {
		headerLen = view.getUint16(8, true)
		dataOffset = 10 + headerLen
	} else if (major === 2) {
		headerLen = view.getUint32(8, true)
		dataOffset = 12 + headerLen
	} else {
		throw new Error(`Unsupported .npy version: ${major}.${minor}`)
	}

	const decoder = new TextDecoder('latin1')
	const headerText = decoder.decode(
		new Uint8Array(buffer, dataOffset - headerLen, headerLen)
	)
	const { shape, descr, fortranOrder } = parseNpyHeader(headerText)
	if (shape.length !== 3) {
		throw new Error(`Only 3D voxel arrays are supported. shape=${shape}`)
	}
	if (fortranOrder) {
		throw new Error('Fortran-order arrays are not supported.')
	}
	if (descr !== '|u1' && descr !== '|b1' && descr !== '<u1') {
		throw new Error(`Only uint8/bool npy is supported. descr=${descr}`)
	}

	const count = shape[0] * shape[1] * shape[2]
	const data = new Uint8Array(buffer, dataOffset, count)
	return { shape, data }
}

export function voxelsFromNpyParsed(parsed) {
	const [sx, sy, sz] = parsed.shape
	const voxels = []
	let idx = 0
	for (let x = 0; x < sx; x += 1) {
		for (let y = 0; y < sy; y += 1) {
			for (let z = 0; z < sz; z += 1) {
				if (parsed.data[idx] !== 0) {
					voxels.push({ x, y, z })
				}
				idx += 1
			}
		}
	}
	return voxels
}

export async function loadVoxelsFromSpec(spec) {
	const npyPaths = []
	if (typeof spec.npy === 'string' && spec.npy.length > 0) {
		npyPaths.push(spec.npy)
	}
	if (Array.isArray(spec.npyFiles)) {
		for (const p of spec.npyFiles) {
			if (typeof p === 'string' && p.length > 0) {
				npyPaths.push(p)
			}
		}
	}

	if (npyPaths.length === 0) {
		console.warn(
			'parts npy 생략 — msgpack solids 로만 렌더링하는 경우일 수 있습니다:',
			spec?.name
		)
		return []
	}

	const merged = new Map()
	for (const path of npyPaths) {
		const res = await fetch(path)
		if (!res.ok) {
			throw new Error(`${path}: ${res.status}`)
		}
		const parsed = parseNpyArrayBuffer(await res.arrayBuffer())
		const voxels = voxelsFromNpyParsed(parsed)
		for (const v of voxels) {
			merged.set(`${v.x},${v.y},${v.z}`, v)
		}
	}

	return [...merged.values()]
}

/**
 * 매니페스트 `grid` — 서버가 msgpack metadata에서 복사한 값 (없으면 null).
 * @param {object} voxelDoc
 * @returns {Promise<GridMeta | null>}
 */
export async function loadGridMeta(voxelDoc) {
	const g = voxelDoc?.grid
	if (
		g &&
		Array.isArray(g.origin) &&
		g.origin.length === 3 &&
		Number.isFinite(Number(g.voxelSize)) &&
		Number(g.voxelSize) > 0
	) {
		return {
			origin: g.origin.map(Number),
			voxelSize: Number(g.voxelSize),
			resolution: Array.isArray(g.resolution) ? g.resolution.map(Number) : null,
		}
	}
	return null
}

/**
 * 조립 msgpack `metadata`만으로 그리드 메타 구성 (매니페스트 `grid` 없을 때 보조).
 * @param {object | null} decoded — `decodeAssemblyBuffer` 결과
 * @returns {GridMeta | null}
 */
export function gridMetaFromAssemblyDecoded(decoded) {
	const m = decoded?.metadata
	if (!m || typeof m !== 'object') return null
	const origin =
		Array.isArray(m.origin) && m.origin.length === 3
			? m.origin
			: Array.isArray(m.min_bound) && m.min_bound.length === 3
				? m.min_bound
				: null
	if (!origin) return null
	const vs = Number(m.voxel_size ?? m.voxelSize)
	if (!Number.isFinite(vs) || vs <= 0) return null
	return {
		origin: origin.map(Number),
		voxelSize: vs,
		resolution: Array.isArray(m.resolution) ? m.resolution.map(Number) : null,
	}
}

export function voxelCenterWorld(v, grid, target) {
	const s = grid.voxelSize
	const o = grid.origin
	return target.set(
		o[0] + (v.x + 0.5) * s,
		o[1] + (v.y + 0.5) * s,
		o[2] + (v.z + 0.5) * s
	)
}

export function bboxCenterFromVoxels(voxels, grid, targetCenter) {
	const box = new THREE.Box3()
	const p = new THREE.Vector3()
	for (const v of voxels) {
		voxelCenterWorld(v, grid, p)
		box.expandByPoint(p)
	}
	if (box.isEmpty()) {
		targetCenter.set(0, 0, 0)
		return targetCenter
	}
	return box.getCenter(targetCenter)
}

/** 케이스 앵커 기준(월드격자 − mainAnchor)에서 부품 AABB 중심 — 스폰·회전 피벗 */
export function partPivotInCaseFrame(voxels, grid, mainAnchor, target) {
	const box = new THREE.Box3()
	const p = new THREE.Vector3()
	for (const v of voxels) {
		voxelCenterWorld(v, grid, p)
		p.sub(mainAnchor)
		box.expandByPoint(p)
	}
	if (box.isEmpty()) {
		target.set(0, 0, 0)
		return target
	}
	return box.getCenter(target)
}

/**
 * InstancedMesh 복셀·대기열 레이아웃
 * 메인 패널: STEP 원점·격자 스텝에 맞춘 복셀(InstancedMesh).
 * @param {THREE.Vector3 | null} localPivot — 조립 파트만 부품 국소 원점(궤적 회전·스폰 정렬용)
 */
export function createMainWorldVoxelGroup(voxels, voxelSpec, grid, mainAnchor, localPivot) {
	const vs = grid.voxelSize
	const ox = grid.origin[0]
	const oy = grid.origin[1]
	const oz = grid.origin[2]
	const ax = mainAnchor.x
	const ay = mainAnchor.y
	const az = mainAnchor.z
	const px = localPivot ? localPivot.x : 0
	const py = localPivot ? localPivot.y : 0
	const pz = localPivot ? localPivot.z : 0
	const getPos = (v, out) => {
		out.set(
			ox + (v.x + 0.5) * vs - ax - px,
			oy + (v.y + 0.5) * vs - ay - py,
			oz + (v.z + 0.5) * vs - az - pz
		)
	}
	return createInstancedVoxelGroup(voxels, voxelSpec, vs, getPos)
}

/**
 * 대기열: 부품별 복셀 실루엣 (InstancedMesh). AABB 중심 정렬 + 동일 최대 크기로 스케일.
 */
export function createQueueVoxelGroup(
	voxels,
	voxelSpec,
	targetSize = QUEUE_PREVIEW_TARGET_SIZE
) {
	const group = new THREE.Group()
	if (!voxels?.length) return group

	let xmin = Infinity
	let xmax = -Infinity
	let ymin = Infinity
	let ymax = -Infinity
	let zmin = Infinity
	let zmax = -Infinity
	for (const v of voxels) {
		xmin = Math.min(xmin, v.x)
		xmax = Math.max(xmax, v.x)
		ymin = Math.min(ymin, v.y)
		ymax = Math.max(ymax, v.y)
		zmin = Math.min(zmin, v.z)
		zmax = Math.max(zmax, v.z)
	}

	const cx = (xmin + xmax) / 2
	const cy = (ymin + ymax) / 2
	const cz = (zmin + zmax) / 2
	const w = xmax - xmin + 1
	const h = ymax - ymin + 1
	const d = zmax - zmin + 1
	const maxDim = Math.max(w, h, d, 1)
	const normScale = targetSize / maxDim
	// 메인과 동일: 격자 셀 중심 간격 normScale, boxEdge≈normScale (밝은 배경에서 미세 틈 방지)
	const cellSize = normScale / 0.92

	const getPos = (v, out) => {
		out.set(
			(v.x + 0.5 - cx) * normScale,
			(v.y + 0.5 - cy) * normScale,
			(v.z + 0.5 - cz) * normScale
		)
	}
	return createInstancedVoxelGroup(voxels, voxelSpec, cellSize, getPos)
}

export const QUEUE_PREVIEW_TARGET_SIZE = 5.5
/** 대기열 부품 상세 보기(클릭 후 회전) 최대 치수 */
export const QUEUE_DETAIL_TARGET_SIZE = 9
/** 대기열에서 부품과 부품 사이 세로 여백 (목록 구분) */
export const QUEUE_PART_GAP = 2.6

/**
 * 대기열: 부품 1개 = 미리보기 1개 (AABB 실루엣). 복셀을 셀마다 그리지 않음.
 */
export function createQueuePartPreviewGroup(voxels, voxelSpec) {
	const group = new THREE.Group()
	if (!voxels?.length) return group

	let xmin = Infinity
	let xmax = -Infinity
	let ymin = Infinity
	let ymax = -Infinity
	let zmin = Infinity
	let zmax = -Infinity
	for (const v of voxels) {
		xmin = Math.min(xmin, v.x)
		xmax = Math.max(xmax, v.x)
		ymin = Math.min(ymin, v.y)
		ymax = Math.max(ymax, v.y)
		zmin = Math.min(zmin, v.z)
		zmax = Math.max(zmax, v.z)
	}

	const w = xmax - xmin + 1
	const h = ymax - ymin + 1
	const d = zmax - zmin + 1
	const maxDim = Math.max(w, h, d, 1)
	const scale = QUEUE_PREVIEW_TARGET_SIZE / maxDim
	group.userData.previewScale = scale

	const colors = voxelSpec?.colors || {}
	const opacityRaw = Number(voxelSpec?.opacity)
	const opacity = Number.isFinite(opacityRaw)
		? Math.min(1, Math.max(0.02, opacityRaw))
		: 1
	const mainColor = colors.main != null ? colors.main : '#ff3b30'

	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(w * scale, h * scale, d * scale),
		new THREE.MeshStandardMaterial({
			color: new THREE.Color().setStyle(mainColor),
			transparent: opacity < 1,
			opacity,
		})
	)
	group.add(mesh)
	return group
}

function splitVoxelsByAccent(voxels) {
	const main = []
	const accent = []
	for (const v of voxels) {
		if (v.accent) accent.push(v)
		else main.push(v)
	}
	if (main.length === 0 && accent.length > 0) {
		return { main: accent, accent: [] }
	}
	return { main, accent }
}

function createInstancedVoxelGroup(voxels, voxelSpec, cellWorldSize, getPosition) {
	const group = new THREE.Group()
	const colors = voxelSpec?.colors || {}
	const opacityRaw = Number(voxelSpec?.opacity)
	const opacity = Number.isFinite(opacityRaw)
		? Math.min(1, Math.max(0.02, opacityRaw))
		: 1

	const mainColor = colors.main != null ? colors.main : '#ff3b30'
	const accentColor = colors.accent != null ? colors.accent : '#1e88e5'

	const boxEdge = cellWorldSize * 0.95
	const geo = new THREE.BoxGeometry(1, 1, 1)
	const seeThrough = opacity < 0.99
	const useUnlitShell = seeThrough && opacity < 0.22
	const matOptsMain = {
		color: new THREE.Color().setStyle(mainColor),
		transparent: opacity < 1,
		opacity,
		depthWrite: !seeThrough,
		depthTest: true,
	}
	const matOptsAccent = {
		color: new THREE.Color().setStyle(accentColor),
		transparent: opacity < 1,
		opacity,
		depthWrite: !seeThrough,
		depthTest: true,
	}
	const matMain = useUnlitShell
		? new THREE.MeshBasicMaterial(matOptsMain)
		: new THREE.MeshStandardMaterial(matOptsMain)
	const matAccent = useUnlitShell
		? new THREE.MeshBasicMaterial(matOptsAccent)
		: new THREE.MeshStandardMaterial(matOptsAccent)

	const { main, accent } = splitVoxelsByAccent(voxels)
	const quat = new THREE.Quaternion()
	const scaleVec = new THREE.Vector3(boxEdge, boxEdge, boxEdge)
	const matrix = new THREE.Matrix4()
	const pos = new THREE.Vector3()

	const pushMesh = (list, mat) => {
		if (list.length === 0) return
		const mesh = new THREE.InstancedMesh(geo, mat, list.length)
		for (let i = 0; i < list.length; i += 1) {
			getPosition(list[i], pos)
			matrix.compose(pos, quat, scaleVec)
			mesh.setMatrixAt(i, matrix)
		}
		mesh.instanceMatrix.needsUpdate = true
		group.add(mesh)
	}

	pushMesh(main, matMain)
	pushMesh(accent, matAccent)
	return group
}

export function mergeVoxelLists(partRows) {
	const m = new Map()
	for (const row of partRows) {
		for (const v of row.voxels) {
			m.set(`${v.x},${v.y},${v.z}`, v)
		}
	}
	return [...m.values()]
}

/**
 * 대기열 슬롯 배치: 위→아래, 부품 높이 + partGap 으로 적당히 떨어뜨림.
 * @param {THREE.Group[]} groups
 * @param {number} [partGap] 부품 사이 세로 간격
 */
export function layoutQueueSlots(groups, partGap = QUEUE_PART_GAP) {
	const parent = new THREE.Group()
	const n = groups.length
	if (n === 0) return parent

	const layouts = []
	let totalHeight = 0
	for (let i = 0; i < n; i += 1) {
		const g = groups[i]
		g.position.set(0, 0, 0)
		g.rotation.set(0, 0, 0)
		const box = new THREE.Box3().setFromObject(g)
		const h = box.isEmpty() ? QUEUE_PREVIEW_TARGET_SIZE : box.max.y - box.min.y
		layouts.push({ g, box, h })
		totalHeight += h
		if (i < n - 1) totalHeight += partGap
	}

	let top = totalHeight * 0.5
	for (let i = 0; i < layouts.length; i += 1) {
		const { g, box, h } = layouts[i]
		if (box.isEmpty()) {
			g.position.y = top - h * 0.5
			top -= h + partGap
		} else {
			g.position.y = top - box.max.y
			top = g.position.y + box.min.y - partGap
		}
		parent.add(g)
	}
	return parent
}

/**
 * 세로로 이어 붙인 테트리스 “다음 조각” 스타일 대기열 레이아웃.
 * @param baseGap  부품 사이 최소 세로 간격(월드 단위)
 * @param gapHeightScale  부품 높이에 비례해 추가 간격 (spacing = baseGap + gapHeightScale * h)
 */
export function layoutQueueColumn(groups, baseGap, gapHeightScale = 0) {
	const parent = new THREE.Group()
	let top = 0
	for (const g of groups) {
		g.position.set(0, 0, 0)
		g.rotation.set(0, 0, 0)
		const box = new THREE.Box3().setFromObject(g)
		if (box.isEmpty()) {
			parent.add(g)
			continue
		}
		const maxY = box.max.y
		const minY = box.min.y
		const h = maxY - minY
		g.position.y = top - maxY
		const spacing = baseGap + gapHeightScale * h
		top = g.position.y + minY - spacing
		parent.add(g)
	}
	return parent
}
