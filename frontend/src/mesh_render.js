import * as THREE from 'three'
import { Uint32BufferAttribute } from 'three'

import { QUEUE_PREVIEW_TARGET_SIZE, voxelCenterWorld } from './voxel.js'

/**
 * @typedef {{ vertices: Float32Array, faces: Uint32Array, indexCount: number }} MeshData
 */

const COLLISION_HIGHLIGHT_COLOR = 0xe53935

/** 대기열 슬롯·상세 미리보기 — 충돌 마커·내부 형상이 비치도록 */
export const QUEUE_PREVIEW_OPACITY = 0.58

function materialFromPartSpec(partSpec, { unlit = false, queuePreview = false } = {}) {
	const colors = partSpec?.colors || {}
	const opacityRaw = Number(partSpec?.opacity)
	let opacity = Number.isFinite(opacityRaw)
		? Math.min(1, Math.max(0.02, opacityRaw))
		: 1
	if (queuePreview) {
		opacity = Math.min(opacity, QUEUE_PREVIEW_OPACITY)
	}
	const mainColor = colors.main != null ? colors.main : '#ff3b30'
	const seeThrough = opacity < 0.99
	const useUnlitShell = unlit || (seeThrough && opacity < 0.22)
	const matOpts = {
		color: new THREE.Color().setStyle(mainColor),
		transparent: opacity < 1,
		opacity,
		depthWrite: !seeThrough,
		depthTest: true,
		side: THREE.DoubleSide,
	}
	return useUnlitShell
		? new THREE.MeshBasicMaterial(matOpts)
		: new THREE.MeshStandardMaterial(matOpts)
}

/**
 * @param {MeshData} meshData
 * @param {Float32Array | null} [positionOverride] length = vertices.length
 */
export function createBufferGeometryFromMeshData(meshData, positionOverride = null) {
	const geo = new THREE.BufferGeometry()
	const positions =
		positionOverride ??
		new Float32Array(meshData.vertices)
	geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
	if (meshData.indexCount > 0 && meshData.faces?.length) {
		const indices =
			meshData.faces instanceof Uint32Array
				? meshData.faces
				: new Uint32Array(meshData.faces)
		// r170: TypedArray 를 직접 넘기면 index.array 가 없어 draw 시 크래시함
		geo.setIndex(new Uint32BufferAttribute(indices, 1))
	}
	geo.computeVertexNormals()
	geo.computeBoundingBox()
	geo.computeBoundingSphere()
	return geo
}

/** 월드 좌표 mesh → 케이스 프레임 AABB 중심 (mainAnchor 기준) */
export function partPivotInCaseFrameFromMesh(meshData, mainAnchor, target) {
	const box = new THREE.Box3()
	const p = new THREE.Vector3()
	const v = meshData?.vertices
	if (!v?.length) {
		target.set(0, 0, 0)
		return target
	}
	const ax = mainAnchor.x
	const ay = mainAnchor.y
	const az = mainAnchor.z
	for (let i = 0; i < v.length; i += 3) {
		p.set(v[i] - ax, v[i + 1] - ay, v[i + 2] - az)
		box.expandByPoint(p)
	}
	if (box.isEmpty()) {
		target.set(0, 0, 0)
		return target
	}
	return box.getCenter(target)
}

/**
 * @param {{ mesh: MeshData | null }[]} parts
 */
export function bboxCenterFromMeshParts(parts, targetCenter) {
	const box = new THREE.Box3()
	const p = new THREE.Vector3()
	for (const part of parts) {
		const v = part.mesh?.vertices
		if (!v?.length) continue
		for (let i = 0; i < v.length; i += 3) {
			p.set(v[i], v[i + 1], v[i + 2])
			box.expandByPoint(p)
		}
	}
	if (box.isEmpty()) {
		targetCenter.set(0, 0, 0)
		return targetCenter
	}
	return box.getCenter(targetCenter)
}

/**
 * @param {MeshData | null} meshData
 * @param {THREE.Box3} box
 */
export function expandBoxByMeshWorld(meshData, box) {
	const v = meshData?.vertices
	if (!v?.length) return
	const p = new THREE.Vector3()
	for (let i = 0; i < v.length; i += 3) {
		p.set(v[i], v[i + 1], v[i + 2])
		box.expandByPoint(p)
	}
}

/**
 * 메인 조립 뷰: STEP 월드 mesh → 케이스 프레임 로컬 좌표.
 * @param {THREE.Vector3 | null} localPivot — 조립 완료 시 group.position
 */
export function createMainWorldMeshGroup(
	meshData,
	partSpec,
	mainAnchor,
	localPivot
) {
	const group = new THREE.Group()
	if (!meshData?.vertices?.length) return group

	const ax = mainAnchor.x
	const ay = mainAnchor.y
	const az = mainAnchor.z
	const px = localPivot ? localPivot.x : 0
	const py = localPivot ? localPivot.y : 0
	const pz = localPivot ? localPivot.z : 0

	const localPos = new Float32Array(meshData.vertices.length)
	const src = meshData.vertices
	for (let i = 0; i < src.length; i += 3) {
		localPos[i] = src[i] - ax - px
		localPos[i + 1] = src[i + 1] - ay - py
		localPos[i + 2] = src[i + 2] - az - pz
	}

	const geo = createBufferGeometryFromMeshData(meshData, localPos)
	const mesh = new THREE.Mesh(geo, materialFromPartSpec(partSpec))
	mesh.frustumCulled = false
	group.add(mesh)
	return group
}

/** createQueueMeshGroup 과 동일한 mesh AABB 중심·스케일 */
export function queueMeshPreviewFrame(
	meshData,
	targetSize = QUEUE_PREVIEW_TARGET_SIZE
) {
	const frame = { cx: 0, cy: 0, cz: 0, scale: 1 }
	const v = meshData?.vertices
	if (!v?.length) return frame
	let xmin = Infinity
	let xmax = -Infinity
	let ymin = Infinity
	let ymax = -Infinity
	let zmin = Infinity
	let zmax = -Infinity
	for (let i = 0; i < v.length; i += 3) {
		xmin = Math.min(xmin, v[i])
		xmax = Math.max(xmax, v[i])
		ymin = Math.min(ymin, v[i + 1])
		ymax = Math.max(ymax, v[i + 1])
		zmin = Math.min(zmin, v[i + 2])
		zmax = Math.max(zmax, v[i + 2])
	}
	frame.cx = (xmin + xmax) / 2
	frame.cy = (ymin + ymax) / 2
	frame.cz = (zmin + zmax) / 2
	const maxDim = Math.max(xmax - xmin, ymax - ymin, zmax - zmin, 1e-6)
	frame.scale = targetSize / maxDim
	return frame
}

/**
 * 메인 `collisionFogPositionInCaseFrame` 과 동일: 접촉 복셀 → 케이스 프레임 절대 좌표
 * @param {import('./voxel.js').GridMeta} gridMeta
 * @param {THREE.Vector3} mainAnchor
 */
export function collisionPositionInCaseFrame(col, gridMeta, mainAnchor, target) {
	if (!col || !gridMeta?.origin || !gridMeta?.voxelSize) {
		return target.set(0, 0, 0)
	}
	voxelCenterWorld(
		{ x: col.x, y: col.y, z: col.z },
		gridMeta,
		target
	)
	return target.sub(mainAnchor)
}

/**
 * 접촉 복셀 − 부품 mesh pivot (케이스 프레임). 메인 안개 − assembledPosition 과 동일 관계
 * @param {import('./voxel.js').GridMeta} gridMeta
 * @param {THREE.Vector3} mainAnchor
 */
export function contactOffsetInCaseFrameFromMesh(
	meshData,
	collision,
	gridMeta,
	mainAnchor,
	target = new THREE.Vector3()
) {
	if (!collision || !gridMeta || !meshData?.vertices?.length) {
		return target.set(0, 0, 0)
	}
	const contactWorld = new THREE.Vector3()
	const pivot = new THREE.Vector3()
	voxelCenterWorld(
		{ x: collision.x, y: collision.y, z: collision.z },
		gridMeta,
		contactWorld
	)
	partPivotInCaseFrameFromMesh(meshData, mainAnchor, pivot)
	return target.copy(contactWorld).sub(mainAnchor).sub(pivot)
}

/**
 * 대기열 상세: 메인과 동일 case 오프셋을 미리보기 mesh 로컬로 변환
 * @param {import('./voxel.js').GridMeta} gridMeta
 * @param {THREE.Vector3} mainAnchor
 */
export function collisionMarkerOffsetInQueueGroup(
	meshData,
	collision,
	gridMeta,
	mainAnchor,
	targetSize = QUEUE_PREVIEW_TARGET_SIZE
) {
	const out = new THREE.Vector3()
	if (!collision || !gridMeta || !meshData?.vertices?.length) return out
	const { scale } = queueMeshPreviewFrame(meshData, targetSize)
	contactOffsetInCaseFrameFromMesh(
		meshData,
		collision,
		gridMeta,
		mainAnchor,
		out
	)
	return out.multiplyScalar(scale)
}

/** 대기열 상세: 충돌 격자 위치 빨간 마커 */
export function createCollisionMarkerGroup(radius = 0.4) {
	const group = new THREE.Group()
	group.userData.isCollisionMarker = true

	const coreMat = new THREE.MeshBasicMaterial({
		color: 0xff1744,
		transparent: true,
		opacity: 0.95,
		depthTest: true,
		depthWrite: true,
	})
	const core = new THREE.Mesh(new THREE.SphereGeometry(radius, 22, 18), coreMat)
	group.add(core)

	const ringMat = new THREE.MeshBasicMaterial({
		color: 0xff5252,
		transparent: true,
		opacity: 0.55,
		side: THREE.DoubleSide,
		depthWrite: false,
	})
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(radius * 1.15, radius * 1.75, 40),
		ringMat
	)
	ring.rotation.x = -Math.PI / 2
	group.add(ring)

	const wire = new THREE.LineSegments(
		new THREE.EdgesGeometry(new THREE.BoxGeometry(radius * 2.4, radius * 2.4, radius * 2.4)),
		new THREE.LineBasicMaterial({ color: 0xb71c1c, transparent: true, opacity: 0.85 })
	)
	group.add(wire)

	return group
}

/** @param {THREE.Group} group */
export function updateCollisionMarkerPulse(group, timeSec) {
	if (!group?.userData?.isCollisionMarker) return
	const pulse = 1 + 0.14 * Math.sin(timeSec * 5.5)
	group.scale.setScalar(pulse)
	group.children.forEach((child, i) => {
		if (!child.isMesh || !child.material) return
		if (i === 0) child.material.opacity = 0.78 + 0.14 * Math.sin(timeSec * 5.5)
	})
}

/** 충돌 격자 셀 근처 — 부품 전체가 아닌 접촉 지점 안개 */
export function createCollisionFogGroup(cellSize, casePosition) {
	const group = new THREE.Group()
	group.position.copy(casePosition)
	const s = Math.max(1e-3, cellSize)
	const layers = 5
	for (let i = 0; i < layers; i += 1) {
		const r = s * (0.35 + i * 0.22)
		const geo = new THREE.SphereGeometry(r, 16, 12)
		const mat = new THREE.MeshBasicMaterial({
			color: 0xff1744,
			transparent: true,
			opacity: 0.32 - i * 0.05,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		})
		const shell = new THREE.Mesh(geo, mat)
		shell.userData.fogLayer = i
		group.add(shell)
	}
	return group
}

/** @param {THREE.Group} group */
export function updateCollisionFogPulse(group, t01) {
	const pulse = 0.55 + 0.45 * Math.sin(Math.min(1, Math.max(0, t01)) * Math.PI * 3)
	group.traverse((obj) => {
		if (!obj.isMesh || obj.userData.fogLayer === undefined) return
		const base = 0.24 - obj.userData.fogLayer * 0.03
		obj.material.opacity = base * pulse
	})
}

/** 충돌 하이라이트 (복원 가능) */
export function setGroupMeshHighlight(group, active) {
	if (!group) return
	group.traverse((obj) => {
		if (!obj.isMesh || !obj.material) return
		const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
		for (const mat of mats) {
			if (!mat.userData) mat.userData = {}
			if (active) {
				if (mat.userData._dcOrigColor === undefined) {
					mat.userData._dcOrigColor = mat.color.getHex()
				}
				mat.color.setHex(COLLISION_HIGHLIGHT_COLOR)
				if ('emissive' in mat && mat.emissive) {
					if (mat.userData._dcOrigEmissive === undefined) {
						mat.userData._dcOrigEmissive = mat.emissive.getHex()
					}
					mat.emissive.setHex(0x550000)
				}
			} else if (mat.userData._dcOrigColor !== undefined) {
				mat.color.setHex(mat.userData._dcOrigColor)
				if ('emissive' in mat && mat.emissive && mat.userData._dcOrigEmissive !== undefined) {
					mat.emissive.setHex(mat.userData._dcOrigEmissive)
				}
			}
		}
	})
}

/** 대기열 슬롯·상세: AABB 중심 정렬 + 균일 스케일 */
export function createQueueMeshGroup(
	meshData,
	partSpec,
	targetSize = QUEUE_PREVIEW_TARGET_SIZE,
	{ collisionFailed = false } = {}
) {
	const group = new THREE.Group()
	const v = meshData?.vertices
	if (!v?.length) return group

	let xmin = Infinity
	let xmax = -Infinity
	let ymin = Infinity
	let ymax = -Infinity
	let zmin = Infinity
	let zmax = -Infinity
	for (let i = 0; i < v.length; i += 3) {
		xmin = Math.min(xmin, v[i])
		xmax = Math.max(xmax, v[i])
		ymin = Math.min(ymin, v[i + 1])
		ymax = Math.max(ymax, v[i + 1])
		zmin = Math.min(zmin, v[i + 2])
		zmax = Math.max(zmax, v[i + 2])
	}

	const cx = (xmin + xmax) / 2
	const cy = (ymin + ymax) / 2
	const cz = (zmin + zmax) / 2
	const w = xmax - xmin
	const h = ymax - ymin
	const d = zmax - zmin
	const maxDim = Math.max(w, h, d, 1e-6)
	const scale = targetSize / maxDim

	const localPos = new Float32Array(v.length)
	for (let i = 0; i < v.length; i += 3) {
		localPos[i] = (v[i] - cx) * scale
		localPos[i + 1] = (v[i + 1] - cy) * scale
		localPos[i + 2] = (v[i + 2] - cz) * scale
	}

	const geo = createBufferGeometryFromMeshData(meshData, localPos)
	const mesh = new THREE.Mesh(
		geo,
		materialFromPartSpec(partSpec, { unlit: true })
	)
	mesh.frustumCulled = false
	group.add(mesh)
	// collisionFailed: 대기열은 슬롯 배경·「충돌 발생」 라벨로 표시, mesh 는 meta 색 유지
	return group
}
