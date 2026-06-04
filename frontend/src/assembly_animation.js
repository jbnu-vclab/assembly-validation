import * as THREE from 'three'

import {
	assemblySequenceQueueNames,
	decodeAssemblyBuffer,
	parseFailedCollisionsMap,
	trajectoriesToParsedCommands,
	validateAssemblyIndicesAgainstManifest,
} from './assembly_trajectory.js'
import {
	DIR_TO_WORLD_AXIS,
	MAIN_VIEW_LAYER,
	ROTATION_AXIS_TO_WORLD_AXIS,
	traverseSetLayer,
} from './viewer_constants.js'
import {
	createMainWorldMeshGroup,
	partPivotInCaseFrameFromMesh,
	expandBoxByMeshWorld,
	collisionPositionInCaseFrame,
	contactOffsetInCaseFrameFromMesh,
	createCollisionFogGroup,
	updateCollisionFogPulse,
} from './mesh_render.js'
import { voxelCenterWorld } from './voxel.js'

export {
	assemblySequenceQueueNames,
	decodeAssemblyBuffer,
	flatGridToVoxels,
	getSolidsMap,
	normalizeAngleDegTo90,
	queuePartNamesFromMsgpack,
	parseFailedCollisionsMap,
	trajectoriesToParsedCommands,
	trajectoryStepToCommand,
	unpackPackedBitsToFlat,
	validateAssemblyIndicesAgainstManifest,
	voxelsForSolidFromDecoded,
	meshForManifestPartIndex,
	decodeMeshEntry,
	getMeshesMap,
} from './assembly_trajectory.js'

// 조립 msgpack 궤적 재생

const ASSEMBLY_PLAYBACK_RATE = 0.4
const MOVE_SPEED_CELLS_PER_SEC = 10.5 * ASSEMBLY_PLAYBACK_RATE
const ROTATION_SPEED_DEG_PER_SEC = 600 * ASSEMBLY_PLAYBACK_RATE
const COLLISION_FOG_HOLD_SEC = 1.25

/** @typedef {{ x: number, y: number, z: number, attempt: string }} FailedCollisionPoint */
/** @typedef {{ spec: object, mesh: import('./mesh_render.js').MeshData | null, failedCollision?: FailedCollisionPoint | null }} QueuePart */

/**
 * @param {unknown[][]} commands
 * @param {number} cellSize
 * @returns {THREE.Vector3}
 */
/** @param {unknown[]} cmd */
function commandDurationSec(cmd) {
	const [type, , value] = cmd
	if (type === 'MOVE') {
		return Math.max(0, Math.abs(Number(value)) / MOVE_SPEED_CELLS_PER_SEC)
	}
	return Math.max(0, Math.abs(Number(value)) / ROTATION_SPEED_DEG_PER_SEC)
}

function escapeOffsetFromCommands(commands, cellSize) {
	const v = new THREE.Vector3(0, 0, 0)
	for (const cmd of commands) {
		if (!cmd || cmd[0] !== 'MOVE') continue
		const [, dir, cells] = cmd
		const axis = DIR_TO_WORLD_AXIS[dir]
		if (!axis) continue
		v.addScaledVector(axis, -Number(cells) * cellSize)
	}
	return v
}

/**
 * @param {object} ctx
 * @param {THREE.Group} ctx.assemblyStagingRoot
 * @param {import('./voxel.js').GridMeta | null} ctx.gridMeta
 * @param {THREE.Vector3} ctx.mainAnchorVec
 * @param {QueuePart[]} ctx.queuePartList
 * @param {object[]} ctx.voxelDocParts
 * @param {string} ctx.stemForAssembly
 * @param {() => object | null} ctx.getPreloadedDecoded
 * @param {(v: object | null) => void} ctx.setPreloadedDecoded
 * @param {(state: 'idle' | 'playing' | 'paused') => void} [ctx.onPlaybackActiveChange]
 * @param {(elapsed: number, total: number) => void} [ctx.onPlaybackProgress]
 * @param {() => void} [ctx.onMainCameraLayout]
 */
export function createAssemblyPlayback(ctx) {
	const {
		assemblyStagingRoot,
		gridMeta,
		mainAnchorVec,
		queuePartList,
		voxelDocParts,
		stemForAssembly,
		getPreloadedDecoded,
		setPreloadedDecoded,
		onPlaybackActiveChange,
		onPlaybackProgress,
		onMainCameraLayout,
	} = ctx

	const assemblyStartWorld = new THREE.Vector3()
	let assemblyPlaybackActive = false
	let assemblyPaused = false
	let assemblyStopAfterCurrentPart = false
	let assemblyOrderNames = []
	/** @type {string[]} */
	let failedOrderNames = []
	let assemblySeqIndex = 0
	/** @type {Record<string, unknown[][]>} */
	let assemblyTrajMapRef = {}
	let assemblyUseEscapeSpawn = false
	let assemblySharedSpawnNext = false
	const sequentialSharedStagingOrigin = new THREE.Vector3()
	let stagingDrawOrder = 8
	/** @type {THREE.Group | null} */
	let collisionFogGroup = null

	const stagingAnimState = {
		entry: { name: '', group: null },
		commands: [],
		cursor: 0,
		phase: null,
		phaseTime: 0,
		phaseDuration: 0,
		fromPos: new THREE.Vector3(),
		toPos: new THREE.Vector3(),
		fromQuat: new THREE.Quaternion(),
		toQuat: new THREE.Quaternion(),
	}

	const animCellSize = gridMeta?.voxelSize ?? 1
	const pivotScratch = new THREE.Vector3()
	const offsetScratch = new THREE.Vector3()

	/** @type {{ segments: object[], totalDuration: number } | null} */
	let playbackTimeline = null
	let playbackElapsed = 0

	function notifyPlaybackProgress() {
		if (typeof onPlaybackProgress !== 'function') return
		const total = playbackTimeline?.totalDuration ?? 0
		onPlaybackProgress(playbackElapsed, total)
	}

	function partRowByName(partName) {
		return queuePartList.find((p) => p.spec?.name === partName) ?? null
	}

	/** failed_collisions 격자 인덱스 → 케이스 프레임(assemblyStagingRoot) 위치 */
	function collisionFogPositionInCaseFrame(col) {
		const out = new THREE.Vector3()
		if (!col) return out
		if (gridMeta?.origin && gridMeta.voxelSize) {
			return collisionPositionInCaseFrame(col, gridMeta, mainAnchorVec, out)
		}
		out.set(
			col.x * animCellSize,
			col.y * animCellSize,
			col.z * animCellSize
		)
		return out
	}

	function partOrderKey(partName) {
		const m = String(partName).match(/(\d+)/)
		return m ? Number(m[1]) : 9999
	}

	function clearCollisionFog() {
		if (collisionFogGroup) {
			collisionFogGroup.parent?.remove(collisionFogGroup)
			collisionFogGroup = null
		}
	}

	/** 분해 실패 부품 제외, 나머지는 조립 완료 pose (part_12 등 베이스라인) */
	function showAssembledBaseline() {
		clearCollisionFog()
		clearAssemblyStagingMeshes()
		stagingDrawOrder = 8
		assemblyStagingRoot.position.set(0, 0, 0)
		assemblyStagingRoot.quaternion.identity()
		for (const p of queuePartList) {
			const nm = p.spec?.name
			if (!nm || failedOrderNames.includes(nm)) continue
			if (!p.mesh?.vertices?.length) continue
			addAssembledPartMesh(nm)
		}
	}

	/**
	 * 충돌 안개: 부품은 궤적 끝 pose 유지, 접촉 복셀은 mesh pivot 기준 로컬 오프셋.
	 * @param {import('./mesh_render.js').MeshData | null} [meshData]
	 * @param {THREE.Group | null} [partGroup]
	 */
	function attachCollisionFog(col, partGroup = null, meshData = null) {
		clearCollisionFog()
		if (!col) return

		const drawOrder = stagingDrawOrder + 20
		if (
			partGroup &&
			meshData?.vertices?.length &&
			gridMeta?.origin &&
			gridMeta.voxelSize
		) {
			contactOffsetInCaseFrameFromMesh(
				meshData,
				col,
				gridMeta,
				mainAnchorVec,
				offsetScratch
			)
			collisionFogGroup = createCollisionFogGroup(animCellSize, offsetScratch)
			traverseSetLayer(collisionFogGroup, MAIN_VIEW_LAYER)
			collisionFogGroup.traverse((obj) => {
				if (obj.isMesh) obj.renderOrder = drawOrder
			})
			partGroup.add(collisionFogGroup)
			return
		}

		const pos = collisionFogPositionInCaseFrame(col)
		collisionFogGroup = createCollisionFogGroup(animCellSize, pos)
		traverseSetLayer(collisionFogGroup, MAIN_VIEW_LAYER)
		collisionFogGroup.traverse((obj) => {
			if (obj.isMesh) obj.renderOrder = drawOrder
		})
		assemblyStagingRoot.add(collisionFogGroup)
	}

	/** 궤적 종료 직후: 부품 위치 유지 + 접촉 지점만 안개 */
	function beginCollisionFogPhase() {
		const nm = stagingAnimState.entry.name
		const g = stagingAnimState.entry.group
		const part = partRowByName(nm)
		attachCollisionFog(part?.failedCollision ?? null, g, part?.mesh ?? null)
		stagingAnimState.phase = 'COLLISION_FOG'
		stagingAnimState.phaseDuration = COLLISION_FOG_HOLD_SEC
		stagingAnimState.phaseTime = 0
	}

	function buildPlaybackTimeline() {
		/** @type {object[]} */
		const segments = []
		let t = 0
		for (let seqIndex = 0; seqIndex < assemblyOrderNames.length; seqIndex += 1) {
			const partName = assemblyOrderNames[seqIndex]
			const commands = assemblyTrajMapRef[partName] ?? []
			if (commands.length === 0) {
				segments.push({
					kind: 'instant',
					partName,
					seqIndex,
					t0: t,
					t1: t,
				})
				continue
			}
			for (let cmdIndex = 0; cmdIndex < commands.length; cmdIndex += 1) {
				const cmd = commands[cmdIndex]
				const dur = commandDurationSec(cmd)
				segments.push({
					kind: 'command',
					partName,
					seqIndex,
					cmdIndex,
					cmd,
					t0: t,
					t1: t + dur,
				})
				t += dur
			}
		}
		const baseSeq = assemblyOrderNames.length
		for (let fi = 0; fi < failedOrderNames.length; fi += 1) {
			const partName = failedOrderNames[fi]
			const part = partRowByName(partName)
			const col = part?.failedCollision
			const commands = assemblyTrajMapRef[partName] ?? []
			const seqIndex = baseSeq + fi
			for (let cmdIndex = 0; cmdIndex < commands.length; cmdIndex += 1) {
				const cmd = commands[cmdIndex]
				const dur = commandDurationSec(cmd)
				segments.push({
					kind: 'failed_command',
					partName,
					seqIndex,
					fi,
					cmdIndex,
					cmd,
					collision: col,
					t0: t,
					t1: t + dur,
				})
				t += dur
			}
			if (col) {
				segments.push({
					kind: 'collision_fog',
					partName,
					seqIndex,
					fi,
					collision: col,
					t0: t,
					t1: t + COLLISION_FOG_HOLD_SEC,
				})
				t += COLLISION_FOG_HOLD_SEC
			}
		}
		playbackTimeline = { segments, totalDuration: t }
		notifyPlaybackProgress()
	}

	function applyPartialCommand(state, localT) {
		if (!state.entry.group || !state.phase) return
		const dur = state.phaseDuration
		const t = dur <= 1e-8 ? 1 : Math.min(1, Math.max(0, localT / dur))
		state.phaseTime = localT
		if (state.phase === 'MOVE') {
			state.entry.group.position.lerpVectors(state.fromPos, state.toPos, t)
		} else {
			state.entry.group.quaternion.copy(state.fromQuat).slerp(state.toQuat, t)
		}
	}

	function simulatePartCommandsUpTo(state, throughCmdIndex, partialLocalT) {
		const cmds = state.commands
		if (!cmds.length) {
			state.cursor = 0
			state.phase = null
			return
		}
		for (let c = 0; c < throughCmdIndex; c += 1) {
			beginPartCommand(state, cmds[c])
			finishPartCommand(state, cmds[c])
		}
		if (throughCmdIndex < cmds.length) {
			beginPartCommand(state, cmds[throughCmdIndex])
			applyPartialCommand(state, partialLocalT)
			state.cursor = throughCmdIndex
		} else {
			state.cursor = cmds.length
			state.phase = null
			state.phaseTime = 0
		}
	}

	function seekToTime(targetTime) {
		const tl = playbackTimeline
		if (!tl) return

		const total = tl.totalDuration
		playbackElapsed = Math.max(0, Math.min(total, targetTime))

		clearAssemblyStagingMeshes()
		stagingDrawOrder = 8
		assemblyStagingRoot.position.set(0, 0, 0)
		assemblyStagingRoot.quaternion.identity()

		let completedThroughSeq = -1
		/** @type {object | null} */
		let activeCommand = null
		/** @type {object | null} */
		let activeFailedCommand = null
		/** @type {object | null} */
		let activeFogSeg = null
		const tEps = 1e-5
		for (const seg of tl.segments) {
			if (playbackElapsed >= seg.t1 - tEps) {
				completedThroughSeq = Math.max(completedThroughSeq, seg.seqIndex)
			}
			if (
				!activeCommand &&
				seg.kind === 'command' &&
				playbackElapsed >= seg.t0 - tEps &&
				playbackElapsed < seg.t1 - tEps
			) {
				activeCommand = seg
			}
			if (
				!activeFailedCommand &&
				seg.kind === 'failed_command' &&
				playbackElapsed >= seg.t0 - tEps &&
				playbackElapsed < seg.t1 - tEps
			) {
				activeFailedCommand = seg
			}
			if (
				!activeFogSeg &&
				seg.kind === 'collision_fog' &&
				playbackElapsed >= seg.t0 - tEps &&
				playbackElapsed < seg.t1 - tEps
			) {
				activeFogSeg = seg
			}
		}

		if (activeFogSeg) {
			showAssembledBaseline()
			assemblySeqIndex = activeFogSeg.seqIndex
			spawnStagingPartForName(activeFogSeg.partName, {
				keepExisting: true,
			})
			const g = stagingAnimState.entry.group
			const cmds = assemblyTrajMapRef[activeFogSeg.partName] ?? []
			const fogPart = partRowByName(activeFogSeg.partName)
			if (g && cmds.length > 0) {
				applySpawnPosition(g, cmds, activeFogSeg.seqIndex)
				for (let c = 0; c < cmds.length; c += 1) {
					beginPartCommand(stagingAnimState, cmds[c])
					finishPartCommand(stagingAnimState, cmds[c])
				}
				stagingAnimState.cursor = cmds.length
				stagingAnimState.phase = null
			} else if (g) {
				applySpawnPosition(g, cmds, activeFogSeg.seqIndex)
			}
			attachCollisionFog(
				activeFogSeg.collision,
				g,
				fogPart?.mesh ?? null
			)
			stagingAnimState.phase = 'COLLISION_FOG'
			stagingAnimState.phaseDuration = COLLISION_FOG_HOLD_SEC
			stagingAnimState.phaseTime = Math.max(
				0,
				playbackElapsed - activeFogSeg.t0
			)
			assemblyPlaybackActive = true
		} else if (activeFailedCommand) {
			showAssembledBaseline()
			assemblySeqIndex = activeFailedCommand.seqIndex
			spawnStagingPartForName(activeFailedCommand.partName, {
				keepExisting: true,
			})
			const g = stagingAnimState.entry.group
			const cmds = assemblyTrajMapRef[activeFailedCommand.partName] ?? []
			if (g) {
				applySpawnPosition(g, cmds, activeFailedCommand.seqIndex)
				simulatePartCommandsUpTo(
					stagingAnimState,
					activeFailedCommand.cmdIndex,
					Math.max(0, playbackElapsed - activeFailedCommand.t0)
				)
			}
			assemblyPlaybackActive = true
		} else if (activeCommand) {
			for (let i = 0; i < activeCommand.seqIndex; i += 1) {
				addAssembledPartMesh(assemblyOrderNames[i])
			}
			assemblySeqIndex = activeCommand.seqIndex
			spawnStagingPartForName(activeCommand.partName, {
				keepExisting: Boolean(gridMeta && activeCommand.seqIndex > 0),
			})
			const g = stagingAnimState.entry.group
			if (g) {
				applySpawnPosition(
					g,
					stagingAnimState.commands,
					activeCommand.seqIndex
				)
				simulatePartCommandsUpTo(
					stagingAnimState,
					activeCommand.cmdIndex,
					Math.max(0, playbackElapsed - activeCommand.t0)
				)
			}
			assemblyPlaybackActive = true
		} else if (playbackElapsed >= total - 1e-8 && total > 0) {
			showAssembledBaseline()
			assemblyPlaybackActive = false
			assemblySeqIndex =
				assemblyOrderNames.length + failedOrderNames.length
		} else if (completedThroughSeq >= 0) {
			const nextIdx = completedThroughSeq + 1
			if (nextIdx < assemblyOrderNames.length) {
				const nextName = assemblyOrderNames[nextIdx]
				const nextCmds = assemblyTrajMapRef[nextName] ?? []
				for (let i = 0; i < nextIdx; i += 1) {
					addAssembledPartMesh(assemblyOrderNames[i])
				}
				assemblySeqIndex = nextIdx
				if (nextCmds.length > 0) {
					spawnStagingPartForName(nextName, {
						keepExisting: Boolean(gridMeta && nextIdx > 0),
					})
					const g = stagingAnimState.entry.group
					if (g) {
						applySpawnPosition(g, nextCmds, nextIdx)
						stagingAnimState.cursor = 0
						stagingAnimState.phase = null
						stagingAnimState.phaseTime = 0
					}
					assemblyPlaybackActive = true
				} else {
					addAssembledPartMesh(nextName)
					assemblyPlaybackActive = true
				}
			} else {
				for (let i = 0; i < assemblyOrderNames.length; i += 1) {
					addAssembledPartMesh(assemblyOrderNames[i])
				}
				assemblyPlaybackActive = true
			}
		} else {
			assemblyPlaybackActive = false
		}

		notifyPlaybackProgress()
		if (typeof onMainCameraLayout === 'function') {
			onMainCameraLayout()
		}
	}

	function refreshAssemblyStartWorld() {
		const box = new THREE.Box3()
		for (const part of queuePartList) {
			expandBoxByMeshWorld(part.mesh, box)
		}
		if (!box.isEmpty()) {
			const c = box.getCenter(new THREE.Vector3())
			const sz = box.getSize(new THREE.Vector3())
			const margin = Math.max(10, Math.max(sz.x, sz.z) * 0.12)
			assemblyStartWorld.set(c.x + sz.x * 0.5 + margin, c.y, c.z)
			return
		}
		assemblyStartWorld.set(24, 0, 0)
	}

	function clearAssemblyStagingMeshes() {
		clearCollisionFog()
		while (assemblyStagingRoot.children.length > 0) {
			assemblyStagingRoot.remove(assemblyStagingRoot.children[0])
		}
	}

	/**
	 * 조립 완료 pose: 케이스 프레임에서 부품 mesh AABB 중심.
	 * @param {QueuePart} part
	 */
	function assembledPositionForPart(part) {
		if (part.mesh) {
			partPivotInCaseFrameFromMesh(part.mesh, mainAnchorVec, pivotScratch)
			return pivotScratch.clone()
		}
		return new THREE.Vector3(0, 0, 0)
	}

	/** @param {THREE.Object3D} group */
	function snapGroupToAssembledPose(group) {
		if (!group || !gridMeta) return
		const ap = group.userData.assembledPosition
		if (ap instanceof THREE.Vector3) {
			group.position.copy(ap)
		} else {
			group.position.set(0, 0, 0)
		}
		group.quaternion.identity()
	}

	/**
	 * @param {THREE.Object3D} group
	 * @param {unknown[][]} commands
	 * @param {number} seqIndex
	 */
	function applySpawnPosition(group, commands, seqIndex) {
		const ap = group.userData.assembledPosition
		if (!(ap instanceof THREE.Vector3)) {
			group.position.set(0, 0, 0)
			return
		}
		if (!assemblyUseEscapeSpawn) {
			group.position.copy(ap)
			return
		}
		if (assemblySharedSpawnNext && seqIndex > 0) {
			group.position.copy(sequentialSharedStagingOrigin)
			return
		}
		offsetScratch.copy(escapeOffsetFromCommands(commands, animCellSize))
		group.position.copy(ap).add(offsetScratch)
		if (assemblySharedSpawnNext && seqIndex === 0) {
			sequentialSharedStagingOrigin.copy(group.position)
		}
	}

	function spawnStagingPartForName(partName, opts = {}) {
		const keepExisting = opts.keepExisting === true
		if (!keepExisting) {
			clearAssemblyStagingMeshes()
			stagingDrawOrder = 8
		}

		const part = queuePartList.find((p) => p.spec?.name === partName)
		if (!part) {
			stagingAnimState.entry = { name: partName, group: null }
			stagingAnimState.commands = []
			stagingAnimState.cursor = 0
			stagingAnimState.phase = null
			return
		}

		if (!part.mesh) {
			stagingAnimState.entry = { name: partName, group: null }
			stagingAnimState.commands = []
			stagingAnimState.cursor = 0
			stagingAnimState.phase = null
			return
		}

		const assembledPos = assembledPositionForPart(part)
		assemblyStagingRoot.position.set(0, 0, 0)
		assemblyStagingRoot.quaternion.identity()
		const g = createMainWorldMeshGroup(
			part.mesh,
			part.spec,
			mainAnchorVec,
			assembledPos
		)
		g.userData.assembledPosition = assembledPos

		traverseSetLayer(g, MAIN_VIEW_LAYER)
		const drawOrder = stagingDrawOrder
		stagingDrawOrder += 1
		g.traverse((obj) => {
			if (obj.isMesh) obj.renderOrder = drawOrder
		})
		assemblyStagingRoot.add(g)
		stagingAnimState.entry = { name: partName, group: g }
		stagingAnimState.commands = assemblyTrajMapRef[partName] ?? []
		stagingAnimState.cursor = 0
		stagingAnimState.phase = null
		stagingAnimState.phaseTime = 0
	}

	function beginPartCommand(state, cmd) {
		if (!state.entry.group) return
		state.phaseTime = 0
		state.phaseDuration = 0
		const [type, dir, value] = cmd
		if (type === 'MOVE') {
			const axis = DIR_TO_WORLD_AXIS[dir].clone()
			state.fromPos.copy(state.entry.group.position)
			state.toPos
				.copy(state.fromPos)
				.addScaledVector(axis, value * animCellSize)
			state.phase = 'MOVE'
			state.phaseDuration = Math.max(
				0,
				Math.abs(value) / MOVE_SPEED_CELLS_PER_SEC
			)
			return
		}
		const axis = ROTATION_AXIS_TO_WORLD_AXIS[dir].clone().normalize()
		const angleRad = THREE.MathUtils.degToRad(value)
		state.fromQuat.copy(state.entry.group.quaternion)
		state.toQuat.copy(state.fromQuat)
		const qDelta = new THREE.Quaternion().setFromAxisAngle(axis, angleRad)
		state.toQuat.premultiply(qDelta)
		state.phase = 'ROTATION'
		state.phaseDuration = Math.max(
			0,
			Math.abs(value) / ROTATION_SPEED_DEG_PER_SEC
		)
	}

	function finishPartCommand(state, cmd) {
		if (!state.entry.group) return
		const [type] = cmd
		if (type === 'MOVE') {
			state.entry.group.position.copy(state.toPos)
			const s = animCellSize
			state.entry.group.position.x =
				Math.round(state.entry.group.position.x / s) * s
			state.entry.group.position.y =
				Math.round(state.entry.group.position.y / s) * s
			state.entry.group.position.z =
				Math.round(state.entry.group.position.z / s) * s
		} else {
			state.entry.group.quaternion.copy(state.toQuat).normalize()
		}
	}

	function finishAssemblyPlaybackUI() {
		assemblyPlaybackActive = false
		assemblyPaused = false
		assemblyStopAfterCurrentPart = false
		stagingAnimState.entry = { name: '', group: null }
		stagingAnimState.phase = null
		stagingAnimState.commands = []
		stagingAnimState.cursor = 0
		if (playbackTimeline) {
			playbackElapsed = playbackTimeline.totalDuration
			notifyPlaybackProgress()
		}
		if (typeof onPlaybackActiveChange === 'function') {
			onPlaybackActiveChange('idle')
		}
	}

	function startFailedAssemblyAtGlobalIndex(globalIdx) {
		const fi = globalIdx - assemblyOrderNames.length
		if (fi < 0 || fi >= failedOrderNames.length) return false
		const nm = failedOrderNames[fi]
		const part = partRowByName(nm)
		if (!part?.failedCollision) {
			assemblySeqIndex = globalIdx + 1
			return startFailedAssemblyAtGlobalIndex(assemblySeqIndex)
		}
		assemblySeqIndex = globalIdx
		showAssembledBaseline()
		spawnStagingPartForName(nm, { keepExisting: true })
		const g = stagingAnimState.entry.group
		const cmds = assemblyTrajMapRef[nm] ?? []
		stagingAnimState.commands = cmds
		if (!g) {
			assemblySeqIndex = globalIdx + 1
			return startFailedAssemblyAtGlobalIndex(assemblySeqIndex)
		}
		applySpawnPosition(g, cmds, globalIdx)
		if (cmds.length === 0) {
			applySpawnPosition(g, cmds, globalIdx)
			beginCollisionFogPhase()
			return true
		}
		beginPartCommand(stagingAnimState, cmds[0])
		return true
	}

	function advanceSequenceAfterPartDone() {
		const nm = stagingAnimState.entry.name
		const g = stagingAnimState.entry.group
		const isFailedPart = failedOrderNames.includes(nm)

		if (isFailedPart && stagingAnimState.cursor >= stagingAnimState.commands.length) {
			beginCollisionFogPhase()
			return
		}

		if (g && !isFailedPart) {
			snapGroupToAssembledPose(g)
		}
		if (assemblyStopAfterCurrentPart && !isFailedPart) {
			finishAssemblyPlaybackUI()
			if (typeof onMainCameraLayout === 'function') {
				onMainCameraLayout()
			}
			return
		}
		assemblySeqIndex += 1
		if (assemblySeqIndex < assemblyOrderNames.length) {
			if (startStagingSequenceFromCurrentIndex()) {
				if (typeof onMainCameraLayout === 'function') {
					onMainCameraLayout()
				}
				return
			}
		}
		if (startFailedAssemblyAtGlobalIndex(assemblySeqIndex)) {
			if (typeof onMainCameraLayout === 'function') {
				onMainCameraLayout()
			}
			return
		}
		finishAssemblyPlaybackUI()
	}

	/** @param {string} partName */
	function addAssembledPartMesh(partName) {
		const part = queuePartList.find((p) => p.spec?.name === partName)
		if (!part) return null

		if (!part.mesh) return null

		const assembledPos = assembledPositionForPart(part)
		const g = createMainWorldMeshGroup(
			part.mesh,
			part.spec,
			mainAnchorVec,
			assembledPos
		)
		g.userData.assembledPosition = assembledPos

		traverseSetLayer(g, MAIN_VIEW_LAYER)
		const drawOrder = stagingDrawOrder
		stagingDrawOrder += 1
		g.traverse((obj) => {
			if (obj.isMesh) obj.renderOrder = drawOrder
		})
		snapGroupToAssembledPose(g)
		assemblyStagingRoot.add(g)
		return g
	}

	function startStagingSequenceFromCurrentIndex() {
		if (assemblySeqIndex >= assemblyOrderNames.length) {
			return startFailedAssemblyAtGlobalIndex(assemblySeqIndex)
		}
		while (assemblySeqIndex < assemblyOrderNames.length) {
			const nm = assemblyOrderNames[assemblySeqIndex]
			if (!gridMeta) {
				refreshAssemblyStartWorld()
				assemblyStagingRoot.position.copy(assemblyStartWorld)
				assemblyStagingRoot.quaternion.identity()
			}

			spawnStagingPartForName(nm, {
				keepExisting: Boolean(gridMeta && assemblySeqIndex > 0),
			})

			const g0 = stagingAnimState.entry.group
			if (!g0) {
				assemblySeqIndex += 1
				continue
			}

			const cmds0 = stagingAnimState.commands
			if (cmds0.length === 0) {
				snapGroupToAssembledPose(g0)
				assemblySeqIndex += 1
				continue
			}

			applySpawnPosition(g0, cmds0, assemblySeqIndex)
			beginPartCommand(stagingAnimState, cmds0[0])
			return true
		}
		return false
	}

	function assemblyMsgpackUrls() {
		const s = encodeURIComponent(stemForAssembly)
		return [
			`/api/assembly-data?stem=${encodeURIComponent(stemForAssembly)}`,
			`/data/${s}_assembly.msgpack`,
		]
	}

	async function prepareAssemblyPlayback() {
		// 일시정지·스크럽 중에는 데이터만 갱신 (재생 중에만 busy)
		if (assemblyPlaybackActive && !assemblyPaused) {
			return { ok: false, reason: 'busy' }
		}
		if (!stemForAssembly) {
			alert('조립 msgpack stem(업로드 파일명)을 알 수 없습니다.')
			return { ok: false, reason: 'no-stem' }
		}

		let decoded = getPreloadedDecoded()
		if (!decoded) {
			for (const url of assemblyMsgpackUrls()) {
				try {
					const asmRes = await fetch(url, { cache: 'no-store' })
					if (!asmRes.ok) continue
					decoded = decodeAssemblyBuffer(await asmRes.arrayBuffer())
					console.info('조립 msgpack 로드:', url)
					break
				} catch (e) {
					console.warn(`assembly msgpack (${url}):`, e.message)
				}
			}
		} else {
			console.info('조립 msgpack: 사전 로드 분 사용')
		}
		if (!decoded) {
			alert('조립 msgpack을 불러올 수 없습니다.')
			return { ok: false, reason: 'load-failed' }
		}
		setPreloadedDecoded(decoded)

		const manifestMismatch = validateAssemblyIndicesAgainstManifest(
			decoded,
			voxelDocParts
		)
		if (manifestMismatch) {
			alert(manifestMismatch)
			return { ok: false, reason: 'manifest' }
		}

		assemblyTrajMapRef = trajectoriesToParsedCommands(
			decoded.assembly,
			voxelDocParts,
			decoded.metadata,
			decoded
		)
		assemblyOrderNames = assemblySequenceQueueNames(
			decoded.assembly,
			voxelDocParts,
			null,
			decoded
		)
		if (assemblyOrderNames.length === 0) {
			assemblyOrderNames = queuePartList
				.map((p) => p.spec?.name)
				.filter(Boolean)
		}

		const failedMap = parseFailedCollisionsMap(
			decoded.assembly,
			voxelDocParts,
			decoded
		)
		const namesWithTrajectory = assemblyOrderNames.filter(
			(nm) =>
				(assemblyTrajMapRef[nm]?.length ?? 0) > 0 &&
				!failedMap.has(nm)
		)
		assemblyOrderNames = namesWithTrajectory

		failedOrderNames = [...failedMap.keys()].sort(
			(a, b) => partOrderKey(a) - partOrderKey(b)
		)
		for (const p of queuePartList) {
			const nm = p.spec?.name
			if (p.failedCollision && nm && !failedOrderNames.includes(nm)) {
				failedOrderNames.push(nm)
			}
		}
		failedOrderNames.sort((a, b) => partOrderKey(a) - partOrderKey(b))

		if (failedOrderNames.length === 0) {
			for (const p of queuePartList) {
				const nm = p.spec?.name
				if (!nm || assemblyOrderNames.includes(nm)) continue
				if ((assemblyTrajMapRef[nm]?.length ?? 0) > 0) continue
				failedOrderNames.push(nm)
			}
			failedOrderNames.sort((a, b) => partOrderKey(a) - partOrderKey(b))
		}

		if (assemblyOrderNames.length === 0 && failedOrderNames.length === 0) {
			alert(
				'대기열 부품 이름에 해당하는 조립 MOVE/ROTATION 궤적이 없습니다. ' +
					'(msgpack assembly.trajectories가 비었거나, 스텝 형식이 뷰어와 맞지 않을 수 있습니다.)'
			)
			return { ok: false, reason: 'no-trajectory' }
		}

		assemblyUseEscapeSpawn = Boolean(
			gridMeta && decoded.assembly?.initial_offset_from_commands !== false
		)
		assemblySharedSpawnNext = Boolean(decoded.assembly?.shared_spawn)
		sequentialSharedStagingOrigin.set(0, 0, 0)
		buildPlaybackTimeline()

		return { ok: true, decoded }
	}

	async function ensureTimelineReady() {
		if (
			playbackTimeline &&
			playbackTimeline.totalDuration > 0 &&
			assemblyOrderNames.length > 0
		) {
			return true
		}
		const prep = await prepareAssemblyPlayback()
		return prep.ok
	}

	async function seekToProgress(norm) {
		const wasPlaying = assemblyPlaybackActive && !assemblyPaused
		if (wasPlaying) pauseAssemblyPlayback()

		const ready = await ensureTimelineReady()
		if (!ready) return

		const total = playbackTimeline?.totalDuration ?? 0
		if (total <= 0) return

		const clamped = Math.min(1, Math.max(0, Number(norm)))
		if (!Number.isFinite(clamped)) return

		seekToTime(clamped * total)
		assemblyPaused = true
		if (typeof onPlaybackActiveChange === 'function') {
			if (assemblyPlaybackActive) {
				onPlaybackActiveChange('paused')
			} else {
				onPlaybackActiveChange('idle')
			}
		}
	}

	function resetStagingForPlayback() {
		if (gridMeta) {
			clearAssemblyStagingMeshes()
			stagingDrawOrder = 8
			assemblyStagingRoot.position.set(0, 0, 0)
			assemblyStagingRoot.quaternion.identity()
		} else {
			refreshAssemblyStartWorld()
			assemblyStagingRoot.position.copy(assemblyStartWorld)
			assemblyStagingRoot.quaternion.identity()
		}
	}

	function beginAssemblyPlaybackUI() {
		assemblyPaused = false
		if (typeof onPlaybackActiveChange === 'function') {
			onPlaybackActiveChange('playing')
		}
	}

	/** 애니만 멈춤 — 조립물·진행 상태 유지 */
	function pauseAssemblyPlayback() {
		if (!assemblyPlaybackActive || assemblyPaused) return
		assemblyPaused = true
		if (typeof onPlaybackActiveChange === 'function') {
			onPlaybackActiveChange('paused')
		}
	}

	function resumeAssemblyPlayback() {
		if (!assemblyPlaybackActive || !assemblyPaused) return
		assemblyPaused = false
		if (typeof onPlaybackActiveChange === 'function') {
			onPlaybackActiveChange('playing')
		}
	}

	/** 재생·스크럽 전 idle: 스테이징 비움, 타임라인 0초 (타임라인 데이터는 유지) */
	function returnToPrePlaybackIdle() {
		assemblyPlaybackActive = false
		assemblyPaused = false
		assemblyStopAfterCurrentPart = false
		stagingAnimState.entry = { name: '', group: null }
		stagingAnimState.phase = null
		stagingAnimState.commands = []
		stagingAnimState.cursor = 0
		clearAssemblyStagingMeshes()
		stagingDrawOrder = 8
		assemblyStagingRoot.position.set(0, 0, 0)
		assemblyStagingRoot.quaternion.identity()
		playbackElapsed = 0
		notifyPlaybackProgress()
		if (typeof onPlaybackActiveChange === 'function') {
			onPlaybackActiveChange('idle')
		}
		if (typeof onMainCameraLayout === 'function') {
			onMainCameraLayout()
		}
	}

	/** 완전 중단 + 메쉬 제거 (리셋용) */
	function stopAndClearAssembly() {
		assemblyPlaybackActive = false
		assemblyPaused = false
		assemblyStopAfterCurrentPart = false
		stagingAnimState.entry = { name: '', group: null }
		stagingAnimState.phase = null
		stagingAnimState.commands = []
		stagingAnimState.cursor = 0
		clearAssemblyStagingMeshes()
		stagingDrawOrder = 8
		assemblyStagingRoot.position.set(0, 0, 0)
		assemblyStagingRoot.quaternion.identity()
		playbackTimeline = null
		playbackElapsed = 0
		notifyPlaybackProgress()
		if (typeof onPlaybackActiveChange === 'function') {
			onPlaybackActiveChange('idle')
		}
		if (typeof onMainCameraLayout === 'function') {
			onMainCameraLayout()
		}
	}

	async function runAssemblyPlayFull() {
		const prep = await prepareAssemblyPlayback()
		if (!prep.ok) return

		assemblyStopAfterCurrentPart = false
		assemblySeqIndex = 0
		playbackElapsed = 0
		notifyPlaybackProgress()
		resetStagingForPlayback()

		assemblyPlaybackActive = startStagingSequenceFromCurrentIndex()
		if (!assemblyPlaybackActive) {
			alert(
				'첫 조립 순서에서 재생 가능한 궤적을 찾지 못했습니다. ' +
					'(앞선 부품은 궤적이 비어 있고, 뒤쪽에만 경로가 있을 수 있습니다. 콘솔 로그를 확인하세요.)'
			)
			return
		}
		if (typeof onMainCameraLayout === 'function') {
			onMainCameraLayout()
		}
		beginAssemblyPlaybackUI()
	}

	/**
	 * 조립 순서 index(0-based) 한 부품만 재생. 이전 부품은 완료 pose로 메인에 표시.
	 * @param {number} seqIndex
	 */
	async function runAssemblyPlaySingleAtSeqIndex(seqIndex) {
		const prep = await prepareAssemblyPlayback()
		if (!prep.ok) return

		if (seqIndex < 0 || seqIndex >= assemblyOrderNames.length) {
			alert('유효하지 않은 조립 순서입니다.')
			return
		}

		assemblyStopAfterCurrentPart = true
		assemblySeqIndex = seqIndex
		resetStagingForPlayback()

		for (let i = 0; i < seqIndex; i += 1) {
			addAssembledPartMesh(assemblyOrderNames[i])
		}

		assemblyPlaybackActive = startStagingSequenceFromCurrentIndex()
		if (!assemblyPlaybackActive) {
			const nm = assemblyOrderNames[seqIndex]
			if (nm) {
				addAssembledPartMesh(nm)
			}
			finishAssemblyPlaybackUI()
			if (typeof onMainCameraLayout === 'function') {
				onMainCameraLayout()
			}
			return
		}
		if (typeof onMainCameraLayout === 'function') {
			onMainCameraLayout()
		}
		beginAssemblyPlaybackUI()
	}

	async function runAssemblyPlaySingleAtQueueIndex(queueIndex) {
		const part = queuePartList[queueIndex]
		if (!part?.spec?.name) return
		const nm = part.spec.name
		const seqIdx = assemblyOrderNames.indexOf(nm)
		if (seqIdx >= 0) {
			return runAssemblyPlaySingleAtSeqIndex(seqIdx)
		}
		const prep = await prepareAssemblyPlayback()
		if (!prep.ok) return

		assemblyStopAfterCurrentPart = true
		assemblySeqIndex =
			assemblyOrderNames.length + Math.max(0, failedOrderNames.indexOf(nm))
		resetStagingForPlayback()
		if (!startFailedAssemblyAtGlobalIndex(assemblySeqIndex)) {
			finishAssemblyPlaybackUI()
			return
		}
		assemblyPlaybackActive = true
		if (typeof onMainCameraLayout === 'function') {
			onMainCameraLayout()
		}
		beginAssemblyPlaybackUI()
	}

	function tick(delta) {
		if (!assemblyPlaybackActive || assemblyPaused) {
			return
		}
		const state = stagingAnimState
		if (!state.entry.group) {
			return
		}
		if (state.phase === 'COLLISION_FOG') {
			state.phaseTime += delta
			const dur = state.phaseDuration
			if (collisionFogGroup) {
				updateCollisionFogPulse(
					collisionFogGroup,
					dur <= 1e-8 ? 1 : state.phaseTime / dur
				)
			}
			if (state.phaseTime >= dur) {
				if (assemblyStopAfterCurrentPart) {
					showAssembledBaseline()
					finishAssemblyPlaybackUI()
					return
				}
				stagingAnimState.entry = { name: '', group: null }
				stagingAnimState.phase = null
				assemblySeqIndex += 1
				if (startFailedAssemblyAtGlobalIndex(assemblySeqIndex)) {
					if (typeof onMainCameraLayout === 'function') {
						onMainCameraLayout()
					}
				} else {
					finishAssemblyPlaybackUI()
				}
			}
			if (playbackTimeline) {
				playbackElapsed = Math.min(
					playbackTimeline.totalDuration,
					playbackElapsed + delta
				)
				notifyPlaybackProgress()
			}
			return
		}
		if (state.cursor < state.commands.length && state.phase) {
			state.phaseTime += delta
			if (state.phaseDuration <= 1e-8) {
				finishPartCommand(state, state.commands[state.cursor])
				state.cursor += 1
				if (state.cursor < state.commands.length) {
					beginPartCommand(state, state.commands[state.cursor])
				} else {
					advanceSequenceAfterPartDone()
				}
			} else {
				const t = Math.min(1, state.phaseTime / state.phaseDuration)
				if (state.phase === 'MOVE') {
					state.entry.group.position.lerpVectors(
						state.fromPos,
						state.toPos,
						t
					)
				} else {
					state.entry.group.quaternion
						.copy(state.fromQuat)
						.slerp(state.toQuat, t)
				}
				if (t >= 1) {
					finishPartCommand(state, state.commands[state.cursor])
					state.cursor += 1
					if (state.cursor < state.commands.length) {
						beginPartCommand(state, state.commands[state.cursor])
					} else {
						advanceSequenceAfterPartDone()
					}
				}
			}
		}
		if (playbackTimeline && state.phase && state.phase !== 'COLLISION_FOG') {
			const seg = playbackTimeline.segments.find(
				(s) =>
					(s.kind === 'command' || s.kind === 'failed_command') &&
					s.partName === state.entry.name &&
					s.cmdIndex === state.cursor &&
					playbackElapsed >= s.t0 - 1e-5 &&
					playbackElapsed < s.t1 - 1e-5
			)
			if (seg) {
				playbackElapsed = Math.min(
					seg.t1,
					seg.t0 + state.phaseTime
				)
			} else {
				playbackElapsed = Math.min(
					playbackTimeline.totalDuration,
					playbackElapsed + delta
				)
			}
			notifyPlaybackProgress()
		}
	}

	return {
		tick,
		isPlaybackActive: () => assemblyPlaybackActive,
		isPaused: () => assemblyPaused,
		hasTimeline: () =>
			Boolean(playbackTimeline && playbackTimeline.totalDuration > 0),
		getPlaybackDuration: () => playbackTimeline?.totalDuration ?? 0,
		runAssemblyPlayFull,
		runAssemblyPlaySingleAtSeqIndex,
		runAssemblyPlaySingleAtQueueIndex,
		pauseAssemblyPlayback,
		resumeAssemblyPlayback,
		stopAndClearAssembly,
		returnToPrePlaybackIdle,
		seekToProgress,
		ensureTimelineReady,
	}
}
