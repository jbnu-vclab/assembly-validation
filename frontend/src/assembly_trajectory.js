/**
 * `assembly_validation_v3.py` 조립 msgpack 파싱.
 *
 * - 렌더: `meshes` / 경로·충돌: `solids` voxel
 * - `assembly.failed_collisions`: 교착 부품 접촉 격자
 * - `assembly.trajectories` 키: 0-based `"0".."K-1"`, 1-based `"1".."K"`, 또는 part name
 * - 스텝: `{ type, axis, value }` 객체 또는 `["MOVE"|"ROTATION", axis, value]` 배열
 */

import { decode } from '@msgpack/msgpack'

export function normalizeAngleDegTo90(angleDeg) {
	const a = Number(angleDeg)
	if (!Number.isFinite(a)) return 0
	const mod = ((a % 360) + 360) % 360
	const k = Math.round(mod / 90) % 4
	return k * 90
}

function toUint8Array(chunk) {
	if (chunk == null) return null
	if (chunk instanceof Uint8Array) return chunk
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
	}
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
	// msgpack bin 이 number[] 로 디코드된 경우
	if (Array.isArray(chunk) && chunk.length > 0) {
		return Uint8Array.from(chunk)
	}
	return null
}

/** msgpack solid 맵 (`solids` 또는 `parts`) */
export function getSolidsMap(data) {
	if (!data || typeof data !== 'object') return null
	const s = data.solids ?? data.parts
	if (!s || typeof s !== 'object') return null
	return s
}

/** 렌더용 triangle mesh (경로 계산은 solids voxel) */
export function getMeshesMap(data) {
	if (!data || typeof data !== 'object') return null
	const m = data.meshes
	if (!m || typeof m !== 'object') return null
	return m
}

/**
 * msgpack mesh 엔트리 → { vertices, faces, indexCount }
 * @returns {import('./mesh_render.js').MeshData | null}
 */
export function decodeMeshEntry(entry) {
	if (!entry || typeof entry !== 'object') return null
	const vb = toUint8Array(entry.vertices)
	const fb = toUint8Array(entry.faces)
	if (!vb || !fb || vb.byteLength < 12 || fb.byteLength < 4) return null

	// msgpack bin 은 큰 ArrayBuffer 뷰일 수 있어 byteOffset 이 4의 배수가 아님 → slice 로 복사
	const vCopy = vb.slice()
	const fCopy = fb.slice()
	const vertices = new Float32Array(
		vCopy.buffer,
		0,
		vCopy.byteLength >> 2
	)
	if (vertices.length % 3 !== 0) return null

	// WebGL index buffer 는 unsigned 필요 (Int32 는 draw 실패할 수 있음)
	const faces = new Uint32Array(fCopy.buffer, 0, fCopy.byteLength >> 2)
	if (faces.length % 3 !== 0) return null
	return { vertices, faces, indexCount: faces.length }
}

/**
 * numpy.packbits(bitorder='big') 스타일: 바이트 내 MSB가 i*8+0 비트.
 * @returns {Uint8Array} 길이 totalVoxels, 셀당 0/1
 */
export function unpackPackedBitsToFlat(uint8Array, totalVoxels) {
	const u8 = toUint8Array(uint8Array)
	if (!u8 || totalVoxels <= 0) {
		return new Uint8Array(Math.max(0, totalVoxels))
	}
	const flat = new Uint8Array(totalVoxels)
	const byteCount = Math.ceil(totalVoxels / 8)
	for (let i = 0; i < totalVoxels; i += 1) {
		const byteIndex = Math.floor(i / 8)
		if (byteIndex >= u8.length || byteIndex >= byteCount) break
		const bitIndex = 7 - (i % 8)
		flat[i] = (u8[byteIndex] >> bitIndex) & 1
	}
	return flat
}

/** NPY C-order와 동일: x가 가장 느리게 변함 */
export function flatGridToVoxels(flat, shape) {
	const [sx, sy, sz] = shape
	const voxels = []
	let idx = 0
	for (let x = 0; x < sx; x += 1) {
		for (let y = 0; y < sy; y += 1) {
			for (let z = 0; z < sz; z += 1) {
				if (flat[idx] !== 0) {
					voxels.push({ x, y, z })
				}
				idx += 1
			}
		}
	}
	return voxels
}

export function decodeAssemblyBuffer(arrayBuffer) {
	const data = decode(new Uint8Array(arrayBuffer))
	if (!data || typeof data !== 'object') {
		throw new Error('msgpack 조립 데이터가 객체가 아닙니다.')
	}
	return data
}

export function voxelsForSolidFromDecoded(decoded, partKey) {
	const meta = decoded.metadata
	if (!meta || !Array.isArray(meta.resolution) || meta.resolution.length !== 3) {
		throw new Error('metadata.resolution [Nx,Ny,Nz] 가 필요합니다.')
	}
	const [Nx, Ny, Nz] = meta.resolution.map((n) => Number(n))
	const total = Nx * Ny * Nz
	if (!Number.isFinite(total) || total <= 0) {
		throw new Error('유효하지 않은 resolution 입니다.')
	}
	const solids = getSolidsMap(decoded)
	const raw = solids?.[partKey] ?? solids?.[String(partKey)]
	const u8 = toUint8Array(raw)
	if (!u8) {
		return null
	}
	const flat = unpackPackedBitsToFlat(u8, total)
	return flatGridToVoxels(flat, [Nx, Ny, Nz])
}

/** msgpack `solids` compound id 숫자 오름차순 (= `_solids.json` solids 배열 순) */
export function compoundKeysInSolidOrder(decoded) {
	const solids = getSolidsMap(decoded)
	if (!solids || typeof solids !== 'object') return []
	return Object.keys(solids)
		.map((k) => Number(k))
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => a - b)
}

/**
 * 매니페스트 `parts[partIdx]` 에 대응하는 복셀 (solids 키가 0,2,4 처럼 비연속이어도 순서 매칭).
 */
export function voxelsForManifestPartIndex(decoded, partIdx) {
	if (!decoded) return null
	const keys = compoundKeysInSolidOrder(decoded)
	const compoundId = keys[partIdx]
	if (!Number.isFinite(compoundId)) return null
	try {
		return voxelsForSolidFromDecoded(decoded, String(compoundId))
	} catch (e) {
		console.warn(
			'msgpack solid 복호화 실패:',
			partIdx,
			compoundId,
			e.message
		)
		return null
	}
}

/**
 * 매니페스트 `parts[partIdx]` 에 대응하는 mesh (solids 와 동일 compound id 순서).
 * @returns {import('./mesh_render.js').MeshData | null}
 */
export function meshForManifestPartIndex(decoded, partIdx) {
	if (!decoded) return null
	const meshes = getMeshesMap(decoded)
	if (!meshes) return null
	const keys = compoundKeysInSolidOrder(decoded)
	const compoundId = keys[partIdx]
	if (!Number.isFinite(compoundId)) return null
	const raw = meshes[String(compoundId)] ?? meshes[compoundId]
	if (!raw) return null
	try {
		return decodeMeshEntry(raw)
	} catch (e) {
		console.warn(
			'msgpack mesh 복호화 실패:',
			partIdx,
			compoundId,
			e.message
		)
		return null
	}
}

const MOVE_AXIS_TO_DIR = {
	'+X': 'RIGHT',
	'-X': 'LEFT',
	'+Y': 'UP',
	'-Y': 'DOWN',
	'+Z': 'FRONT',
	'-Z': 'BACK',
}

function normMoveAxis(axis) {
	const a = String(axis || '')
		.trim()
		.replace(/\s+/g, '')
	const upper = a.toUpperCase()
	if (MOVE_AXIS_TO_DIR[upper]) return MOVE_AXIS_TO_DIR[upper]
	const compact = upper.replace(/AXIS/gi, '').replace(/WORLD/gi, '')
	if (compact === 'X' || compact === '+X') return 'RIGHT'
	if (compact === '-X') return 'LEFT'
	if (compact === 'Y' || compact === '+Y') return 'UP'
	if (compact === '-Y') return 'DOWN'
	if (compact === 'Z' || compact === '+Z') return 'FRONT'
	if (compact === '-Z') return 'BACK'
	return null
}

function normRotAxis(axis) {
	const raw = String(axis || '').trim()
	if (!raw) return null
	const a = raw.toUpperCase()
	if (a === 'ROLL' || a === 'R') return 'ROLL'
	if (a === 'PITCH' || a === 'P') return 'PITCH'
	if (a === 'YAW' || a === 'Y') return 'YAW'
	const paren = raw.match(/^(roll|pitch|yaw)\s*\(\s*([xyzXYZ])\s*\)/i)
	if (paren) {
		const kind = paren[1].toLowerCase()
		if (kind === 'roll') return 'ROLL'
		if (kind === 'pitch') return 'PITCH'
		if (kind === 'yaw') return 'YAW'
	}
	const lower = raw.toLowerCase()
	if (lower.startsWith('roll')) return 'ROLL'
	if (lower.startsWith('pitch')) return 'PITCH'
	if (lower.startsWith('yaw')) return 'YAW'
	return null
}

function moveCellsFromPayload(step, _metadata) {
	const raw =
		step.value !== undefined && step.value !== null ? step.value : step.val
	const v = Number(raw)
	if (!Number.isFinite(v)) return null
	return Math.round(v)
}

/**
 * 1-based 인덱스 키 사용 여부: `"0"` 이 없고 모든 숫자 키·sequence 값이 ≥1 이면 parts 인덱스는 value-1.
 */
export function detectOneBasedPartIndexing(assembly) {
	const traj = assembly?.trajectories
	const seq = assembly?.sequence
	let seenAny = false
	let seenZero = false
	const consider = (raw) => {
		if (raw === undefined || raw === null) return
		const n = Number(raw)
		if (!Number.isFinite(n)) return
		seenAny = true
		if (n === 0) seenZero = true
	}
	if (traj && typeof traj === 'object' && !Array.isArray(traj)) {
		for (const k of Object.keys(traj)) consider(k)
	}
	if (Array.isArray(seq)) {
		for (const raw of seq) consider(raw)
	}
	return seenAny && !seenZero
}

/**
 * trajectory / sequence 에서 쓰는 숫자를 매니페스트 parts[] 인덱스로 변환.
 */
export function manifestIndexFromAssemblyNumber(n, partsLength, oneBased) {
	const v = Number(n)
	if (!Number.isFinite(v)) return null
	const i = oneBased ? v - 1 : v
	if (!Number.isFinite(i) || i < 0 || i >= partsLength) return null
	return i
}

/**
 * assembly 키(compound id / 0-based index / part name) → parts[].name
 * @param {object | null} [decodedFull]
 */
export function partNameFromAssemblyKey(keyStr, parts, decodedFull = null) {
	if (!Array.isArray(parts)) return null
	const rawStr = String(keyStr)
	const byName = parts.find((p) => p && p.name === rawStr)
	if (byName) return byName.name
	const oneBased = detectOneBasedPartIndexing(
		decodedFull?.assembly ?? null
	)
	const M = parts.length
	const ranked =
		decodedFull != null ? compoundKeysInSolidOrder(decodedFull) : []
	const n = Number(keyStr)
	if (Number.isFinite(n)) {
		if (ranked.length > 0) {
			const mi = ranked.indexOf(n)
			if (mi >= 0) return parts[mi]?.name ?? null
		}
		const idx = manifestIndexFromAssemblyNumber(n, M, oneBased)
		if (idx !== null) return parts[idx]?.name ?? null
	}
	return null
}

/**
 * v3 `failed_collisions` → 접촉 복셀 x,y,z, 에이전트 agent_x/y/z, attempt, move_value?
 * v3 교착 `trajectories` = 조립 장면 장애물 회피 MOVE 접근(분해 역변환 아님).
 * @returns {Map<string, { x: number, y: number, z: number, attempt: string }>}
 */
export function parseFailedCollisionsMap(assembly, parts, decodedFull = null) {
	/** @type {Map<string, { x: number, y: number, z: number, attempt: string }>} */
	const out = new Map()
	const raw = assembly?.failed_collisions
	if (!raw || typeof raw !== 'object' || !Array.isArray(parts)) {
		return out
	}
	for (const [key, col] of Object.entries(raw)) {
		if (!col || typeof col !== 'object') continue
		const x = Number(col.x)
		const y = Number(col.y)
		const z = Number(col.z)
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
			continue
		}
		const name = partNameFromAssemblyKey(key, parts, decodedFull)
		if (!name) continue
		out.set(name, {
			x,
			y,
			z,
			attempt: String(col.attempt ?? ''),
		})
	}
	return out
}

/**
 * msgpack 스텝 객체 → 뷰어 애니용 트리플
 * @returns {["MOVE", string, number] | ["ROTATION", string, number] | null}
 */
export function trajectoryStepToCommand(step, metadata) {
	let obj = step
	if (Array.isArray(step) && step.length >= 2) {
		const t = step[0]
		const axis = step[1]
		const val = step.length >= 3 ? step[2] : undefined
		obj = { type: t, axis, value: val }
	}
	if (!obj || typeof obj !== 'object') return null
	const type = String(obj.type || '').toUpperCase()
	if (type === 'MOVE') {
		const dir = normMoveAxis(obj.axis)
		if (!dir) return null
		const cells = moveCellsFromPayload(obj, metadata)
		if (cells === null) return null
		return ['MOVE', dir, cells]
	}
	if (type === 'ROTATION') {
		let dir = normRotAxis(obj.axis)
		if (!dir && typeof obj.axis === 'string') {
			dir = normRotAxis(obj.axis.replace(/^\+/, ''))
		}
		if (!dir) return null
		const raw =
			obj.value !== undefined && obj.value !== null ? obj.value : obj.val
		const deg = Number(raw)
		if (!Number.isFinite(deg)) return null
		return ['ROTATION', dir, normalizeAngleDegTo90(deg)]
	}
	return null
}

/**
 * assembly.sequence → part name[] (중복 제거). sequence 없으면 manifest 순서.
 * @param {object | null} [decodedFull] — 있으면 sequence 항목이 **compound id** 인 경우 parts[] 에 매핑
 */
export function assemblySequenceQueueNames(
	assembly,
	parts,
	isCaseSpec,
	decodedFull = null
) {
	const names = []
	if (!Array.isArray(parts)) return names
	const oneBased = detectOneBasedPartIndexing(assembly)
	const M = parts.length
	const ranked =
		decodedFull != null ? compoundKeysInSolidOrder(decodedFull) : []
	const seq = assembly?.sequence
	if (Array.isArray(seq) && seq.length > 0) {
		for (const raw of seq) {
			const rawStr = String(raw)
			let spec = parts.find((p) => p && p.name === rawStr) || null
			if (!spec && ranked.length > 0) {
				const cid = Number(raw)
				if (Number.isFinite(cid)) {
					const mi = ranked.indexOf(cid)
					if (mi >= 0) spec = parts[mi] ?? null
				}
			}
			if (!spec) {
				const idx = manifestIndexFromAssemblyNumber(raw, M, oneBased)
				spec = idx !== null ? parts[idx] : null
			}
			if (!spec) continue
			if (typeof isCaseSpec === 'function' && isCaseSpec(spec)) continue
			const nm = spec.name
			if (nm && !names.includes(nm)) names.push(nm)
		}
		if (names.length > 0) return names
	}
	for (let i = 0; i < parts.length; i += 1) {
		const spec = parts[i]
		if (!spec) continue
		if (typeof isCaseSpec === 'function' && isCaseSpec(spec)) continue
		const nm = spec.name
		if (nm) names.push(nm)
	}
	return names
}

/**
 * 대기열 표시 순서: msgpack `assembly.sequence` (= 분해 성공 역순) + 궤적 있음.
 * v2 `failed_collisions` 에 있는 부품은 궤적이 없어도 포함.
 */
export function queuePartNamesFromMsgpack(assembly, parts, decodedFull = null) {
	const names = assemblySequenceQueueNames(
		assembly,
		parts,
		null,
		decodedFull
	)
	if (!assembly || !decodedFull) return names
	const cmds = trajectoriesToParsedCommands(
		assembly,
		parts,
		decodedFull.metadata,
		decodedFull
	)
	const out = names.filter((nm) => (cmds[nm]?.length ?? 0) > 0)
	const failed = parseFailedCollisionsMap(assembly, parts, decodedFull)
	for (const nm of failed.keys()) {
		if (!out.includes(nm)) out.push(nm)
	}
	return out
}

/**
 * assembly.trajectories → part name → 명령 트리플[] (MOVE + ROTATION, 백엔드 순서 유지)
 * @param {object | null} [decodedFull] — 있으면 `solids` 의 compound id 순으로 trajectory 키를 parts[] 에 매핑
 */
export function trajectoriesToParsedCommands(
	assembly,
	parts,
	metadata,
	decodedFull = null
) {
	const traj = assembly?.trajectories
	const out = {}
	if (!traj || typeof traj !== 'object' || !Array.isArray(parts)) {
		return out
	}
	const oneBased = detectOneBasedPartIndexing(assembly)
	const M = parts.length
	const ranked =
		decodedFull != null ? compoundKeysInSolidOrder(decodedFull) : []

	const resolveName = (keyStr) =>
		partNameFromAssemblyKey(keyStr, parts, decodedFull)

	for (const [idxStr, steps] of Object.entries(traj)) {
		const name = resolveName(idxStr)
		if (!name) continue
		if (!Array.isArray(steps) || steps.length === 0) {
			out[name] = []
			continue
		}
		const cmds = []
		for (const s of steps) {
			const c = trajectoryStepToCommand(s, metadata)
			if (c) cmds.push(c)
		}
		out[name] = cmds
	}
	return out
}

/**
 * msgpack assembly.sequence / trajectories 키가 parts[] 길이와 맞는지 검사.
 * @returns {string | null} 오류 시 메시지
 */
export function validateAssemblyIndicesAgainstManifest(decoded, parts) {
	if (!Array.isArray(parts) || parts.length === 0) {
		return '매니페스트 parts 배열이 비어 있습니다.'
	}
	const M = parts.length
	const asm = decoded?.assembly
	const oneBased = detectOneBasedPartIndexing(asm)
	const rankedSolids = compoundKeysInSolidOrder(decoded)
	const seq = asm?.sequence
	if (Array.isArray(seq) && seq.length > 0) {
		for (const raw of seq) {
			const rawStr = String(raw)
			if (parts.some((p) => p && p.name === rawStr)) continue
			const cid = Number(raw)
			if (
				rankedSolids.length > 0 &&
				Number.isFinite(cid) &&
				rankedSolids.includes(cid)
			) {
				continue
			}
			const idx = manifestIndexFromAssemblyNumber(raw, M, oneBased)
			if (idx === null) {
				return (
					`조립 msgpack의 assembly.sequence 값(${JSON.stringify(seq)}, ` +
					`${oneBased ? '1-based' : '0-based'} 해석)이 ` +
					`현재 모델의 parts 개수(${M}개)와 맞지 않습니다. ` +
					`같은 STEP을 다시 업로드·변환하세요.`
				)
			}
		}
	}
	const traj = asm?.trajectories
	if (traj && typeof traj === 'object' && !Array.isArray(traj)) {
		for (const k of Object.keys(traj)) {
			const byName = parts.some((p) => p && p.name === k)
			if (byName) continue
			const cid = Number(k)
			if (
				rankedSolids.length > 0 &&
				Number.isFinite(cid) &&
				rankedSolids.includes(cid)
			) {
				continue
			}
			const idx = manifestIndexFromAssemblyNumber(k, M, oneBased)
			if (idx === null) {
				return (
					`조립 msgpack trajectories 키 "${k}"가 ` +
					`매니페스트 parts(${M}개, ${oneBased ? '1-based' : '0-based'} 키 해석)와 맞지 않습니다. ` +
					`STEP을 다시 변환하거나 keys를 parts[].name / 0~${M - 1} (또는 1~${M})에 맞추세요.`
				)
			}
		}
	}
	return null
}
