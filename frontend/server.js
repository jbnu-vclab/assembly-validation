const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
const { decode } = require('@msgpack/msgpack')

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
const HOST = process.env.HOST || '0.0.0.0'
const REPO_ROOT = path.resolve(__dirname)
/**
 * data/ 저장 규칙 (stem = 업로드 STEP 파일명에서 확장자 제외)
 * 1. step/<name>.step           — 업로드 STEP
 * 2. <stem>_solids.json         — 복셀 격자 메타 + solid별 UI 메타 (geometry는 msgpack)
 * 3. <stem>_assembly.msgpack    — 조립 순서·궤적 (assembly_validation.py 출력)
 */
const DATA_ROOT = path.join(REPO_ROOT, 'data')
const DATASET_STEP_DIR = path.join(DATA_ROOT, 'step')
const BACKEND_ROOT = path.resolve(__dirname, '..', 'backend')
const PIPELINE_SCRIPT = path.join(BACKEND_ROOT, 'assembly_validation_v3.py')
const PIPELINE_VOXEL_SIZE = '20'

function pipelineVoxelSizeMm() {
	const fromEnv = String(process.env.PIPELINE_VOXEL_SIZE ?? '').trim()
	if (/^\d+(\.\d+)?$/.test(fromEnv)) {
		const n = Number(fromEnv)
		if (Number.isFinite(n) && n > 0) return String(n)
	}
	return PIPELINE_VOXEL_SIZE
}

function stemFromStepFileName(safeFileName) {
	const ext = path.extname(safeFileName)
	let stem = path.basename(safeFileName, ext)
	if (!stem || stem.length === 0) stem = 'model'
	return stem
}

function solidsJsonPublicPath(stem) {
	return `/data/${stem}_solids.json`
}

function assemblyMsgpackPublicPath(stem) {
	return `/data/${stem}_assembly.msgpack`
}

function assemblyDataApiPath(stem) {
	return `/api/assembly-data?stem=${encodeURIComponent(stem)}`
}

function assemblyMsgpackAbsPath(stem) {
	const safe = path.basename(String(stem)).replace(/[^a-zA-Z0-9._-]/g, '_')
	return path.join(DATA_ROOT, `${safe}_assembly.msgpack`)
}

function solidsJsonAbsPath(stem) {
	const safe = path.basename(String(stem)).replace(/[^a-zA-Z0-9._-]/g, '_')
	return path.join(DATA_ROOT, `${safe}_solids.json`)
}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.msgpack': 'application/octet-stream',
}

function sendJson(res, statusCode, payload) {
	res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(payload))
}

function ensureDataLayout() {
	for (const dir of [DATA_ROOT, DATASET_STEP_DIR]) {
		fs.mkdirSync(dir, { recursive: true })
	}
}

function safeStepFileName(rawName) {
	const decoded = decodeURIComponent(rawName || 'uploaded.step')
	const base = path.basename(decoded)
	const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_')
	if (!safe.toLowerCase().endsWith('.step') && !safe.toLowerCase().endsWith('.stp')) {
		return `${safe}.step`
	}
	return safe
}

const jobs = new Map()

const PART_OPACITY = 1
const PART_PALETTE = [
	{ main: '#ff5c57', accent: '#ff8a80' },
	{ main: '#ff9f1c', accent: '#ffbf69' },
	{ main: '#ffd60a', accent: '#ffe45e' },
	{ main: '#2ec4b6', accent: '#70e1d7' },
	{ main: '#00bbf9', accent: '#48cae4' },
	{ main: '#4ea8de', accent: '#74c0fc' },
	{ main: '#5e60ce', accent: '#7b2cbf' },
	{ main: '#9d4edd', accent: '#c77dff' },
	{ main: '#f15bb5', accent: '#ff8fab' },
	{ main: '#ef476f', accent: '#ff7096' },
	{ main: '#06d6a0', accent: '#52b788' },
	{ main: '#43aa8b', accent: '#90be6d' },
	{ main: '#577590', accent: '#4d908e' },
	{ main: '#f3722c', accent: '#f9844a' },
]

function getSolidsMap(data) {
	if (!data || typeof data !== 'object') return null
	const s = data.solids ?? data.parts
	if (!s || typeof s !== 'object' || Array.isArray(s)) return null
	return s
}

function gridFromAssemblyMetadata(metadata) {
	const m = metadata
	if (!m || typeof m !== 'object') return null
	const origin =
		Array.isArray(m.origin) && m.origin.length === 3
			? m.origin
			: Array.isArray(m.min_bound) && m.min_bound.length === 3
				? m.min_bound
				: null
	const vs = Number(m.voxel_size ?? m.voxelSize)
	if (!origin || !Number.isFinite(vs) || vs <= 0) return null
	const grid = {
		origin: origin.map((x) => Number(x)),
		voxelSize: vs,
	}
	if (
		Array.isArray(m.resolution) &&
		m.resolution.length === 3 &&
		m.resolution.every((n) => Number.isFinite(Number(n)))
	) {
		grid.resolution = m.resolution.map((n) => Number(n))
	}
	return grid
}

function readAssemblyMsgpack(absPath) {
	const buf = fs.readFileSync(absPath)
	const data = decode(new Uint8Array(buf))
	if (!data || typeof data !== 'object') {
		throw new Error('msgpack 조립 데이터가 객체가 아닙니다.')
	}
	return data
}

/**
 * Python이 쓴 assembly_data.msgpack → data/<stem>_solids.json + data/<stem>_assembly.msgpack
 */
async function persistPipelineOutputs(stem, producedMsgpackPath) {
	const decoded = readAssemblyMsgpack(producedMsgpackPath)
	const grid = gridFromAssemblyMetadata(decoded.metadata)
	if (!grid) {
		throw new Error('msgpack metadata에서 grid를 만들 수 없습니다.')
	}
	const solidsMap = getSolidsMap(decoded)
	if (!solidsMap) {
		throw new Error('msgpack solids가 없습니다.')
	}
	const solidIds = Object.keys(solidsMap)
		.map((k) => Number(k))
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => a - b)
	if (solidIds.length === 0) {
		throw new Error('유효한 solid가 없습니다.')
	}

	const solids = solidIds.map((solidId, i) => ({
		solidId,
		name: `part_${i + 1}`,
		opacity: PART_OPACITY,
		colors: PART_PALETTE[i % PART_PALETTE.length],
	}))

	const destMsgpack = assemblyMsgpackAbsPath(stem)
	const destSolids = solidsJsonAbsPath(stem)
	await fs.promises.copyFile(producedMsgpackPath, destMsgpack)
	const doc = {
		stem,
		grid,
		solids,
	}
	await fs.promises.writeFile(destSolids, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8')
	return { grid, solidCount: solids.length }
}

function runAssemblyPipeline(jobId, stepPath, stem) {
	const voxelSizeUsed = pipelineVoxelSizeMm()
	const producedAssembly = path.join(BACKEND_ROOT, 'assembly_data.msgpack')
	try {
		fs.unlinkSync(producedAssembly)
	} catch {
		// ignore
	}
	try {
		fs.unlinkSync(assemblyMsgpackAbsPath(stem))
	} catch {
		// ignore
	}
	try {
		fs.unlinkSync(solidsJsonAbsPath(stem))
	} catch {
		// ignore
	}

	const job = jobs.get(jobId)
	if (job) job.pipelineVoxelSize = voxelSizeUsed

	const args = [
		'run',
		'--no-capture-output',
		'-n',
		'dc',
		'python',
		'-u',
		PIPELINE_SCRIPT,
		'-s',
		stepPath,
		'-v',
		voxelSizeUsed,
	]
	console.log(
		`[pipeline] ${path.basename(stepPath)} voxel_size=${voxelSizeUsed}mm → assembly_validation.py`
	)
	const child = spawn('conda', args, {
		cwd: BACKEND_ROOT,
		env: { ...process.env, PYTHONUNBUFFERED: '1' },
	})
	if (!job) return
	job.pid = child.pid
	job.status = 'running'
	job.progress = Math.max(job.progress, 2)
	job.message = '복셀화·조립 경로 계산 중...'

	const parseLine = (line) => {
		const text = String(line || '').trim()
		if (!text) return
		job.logs.push(text)
		if (job.logs.length > 300) job.logs.shift()
		const m = text.match(/^PROGRESS\s+(\d+)\s*(.*)$/)
		if (m) {
			job.progress = Math.max(0, Math.min(100, Number(m[1])))
			job.message = m[2] || job.message
		}
	}

	child.stdout.on('data', (chunk) => {
		String(chunk)
			.split(/\r?\n/)
			.forEach(parseLine)
	})
	child.stderr.on('data', (chunk) => {
		String(chunk)
			.split(/\r?\n/)
			.forEach(parseLine)
	})
	child.on('error', (err) => {
		job.status = 'failed'
		job.error = err.message || '변환 실패'
		job.message = '변환 실패'
	})
	child.on('close', (code) => {
		if (code !== 0) {
			job.status = 'failed'
			job.error = job.logs[job.logs.length - 1] || `exit code ${code}`
			job.message = '변환 실패'
			return
		}
		if (!fs.existsSync(producedAssembly)) {
			job.status = 'failed'
			job.error = `assembly_data.msgpack 없음 (${producedAssembly})`
			job.message = '변환 실패'
			return
		}

		job.message = 'solid 메타·msgpack 저장 중...'
		persistPipelineOutputs(stem, producedAssembly)
			.then(({ grid, solidCount }) => {
				try {
					fs.unlinkSync(producedAssembly)
				} catch {
					// ignore
				}
				job.status = 'done'
				job.progress = 100
				job.message = '완료'
				job.gridMeta = grid
				console.log(
					`[done] stem=${stem} solids=${solidCount} → ${path.basename(solidsJsonAbsPath(stem))}, ${path.basename(assemblyMsgpackAbsPath(stem))}`
				)
			})
			.catch((err) => {
				job.status = 'failed'
				job.error = err.message || '산출물 저장 실패'
				job.message = '변환 실패'
				console.error('[persist]', err)
			})
	})
}

function isPathUnderRoot(abs, root) {
	if (abs === root) return true
	const sep = path.sep
	return abs.startsWith(root + sep) || abs.startsWith(root + '/')
}

function resolveFirstExistingFile(urlPath) {
	const rel = urlPath.replace(/^\//, '')
	const abs = path.join(REPO_ROOT, rel)
	if (!isPathUnderRoot(abs, REPO_ROOT)) return null
	try {
		const st = fs.statSync(abs)
		if (st.isFile()) return abs
	} catch {
		// not found
	}
	return null
}

function resolveDataFile(urlPath) {
	if (urlPath !== '/data' && !urlPath.startsWith('/data/')) {
		return null
	}
	const sub = urlPath.replace(/^\/data\/?/, '')
	const dataBase = path.resolve(DATA_ROOT)
	const abs = path.resolve(dataBase, sub)
	if (!isPathUnderRoot(abs, dataBase)) {
		return { error: 403, abs: null }
	}
	try {
		const st = fs.statSync(abs)
		if (st.isFile()) {
			return { error: 0, abs }
		}
	} catch {
		// not found
	}
	return { error: 404, abs: null }
}

function handleStatic(req, res) {
	const rawPath = (req.url || '/').split('?')[0]
	let urlPath = '/'
	try {
		urlPath = decodeURIComponent(rawPath)
	} catch {
		res.writeHead(400)
		res.end('Bad Request')
		return
	}
	if (urlPath === '/' || urlPath === '') {
		res.writeHead(302, { location: '/index.html' })
		res.end()
		return
	}
	if (urlPath === '/voxel_test' || urlPath === '/voxel_test/') {
		res.writeHead(302, { location: '/voxel_test/index.html' })
		res.end()
		return
	}
	const dataResolved = resolveDataFile(urlPath)
	if (dataResolved) {
		if (dataResolved.error === 403) {
			res.writeHead(403)
			res.end('Forbidden')
			return
		}
		if (dataResolved.error === 0 && dataResolved.abs) {
			const ext = path.extname(dataResolved.abs).toLowerCase()
			res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
			fs.createReadStream(dataResolved.abs).pipe(res)
			return
		}
		res.writeHead(404)
		res.end('Not Found')
		return
	}
	const absPath = resolveFirstExistingFile(urlPath)
	if (!absPath) {
		res.writeHead(404)
		res.end('Not Found')
		return
	}
	if (!isPathUnderRoot(absPath, REPO_ROOT)) {
		res.writeHead(403)
		res.end('Forbidden')
		return
	}
	const ext = path.extname(absPath).toLowerCase()
	res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' })
	fs.createReadStream(absPath).pipe(res)
}

const server = http.createServer((req, res) => {
	try {
		if (req.method === 'POST' && req.url === '/api/load-step') {
			const chunks = []
			let total = 0
			const maxBytes = 200 * 1024 * 1024
			req.on('data', (chunk) => {
				total += chunk.length
				if (total > maxBytes) {
					res.writeHead(413)
					res.end('Payload too large')
					req.destroy()
					return
				}
				chunks.push(chunk)
			})
			req.on('end', async () => {
				try {
					const fileName = safeStepFileName(req.headers['x-file-name'])
					const stepBuffer = Buffer.concat(chunks)
					if (stepBuffer.length === 0) {
						sendJson(res, 400, { error: '빈 STEP 파일입니다.' })
						return
					}
					await fs.promises.mkdir(DATASET_STEP_DIR, { recursive: true })
					const stepPath = path.join(DATASET_STEP_DIR, fileName)
					await fs.promises.writeFile(stepPath, stepBuffer)
					const stem = stemFromStepFileName(fileName)
					const jobId = randomUUID()
					jobs.set(jobId, {
						id: jobId,
						status: 'queued',
						progress: 1,
						message: '변환 대기 중...',
						error: null,
						logs: [],
						stepPath,
						voxelBase: stem,
						solidsPath: solidsJsonPublicPath(stem),
						assemblyPath: assemblyDataApiPath(stem),
						assemblyMsgpackPath: assemblyMsgpackPublicPath(stem),
						createdAt: Date.now(),
					})
					runAssemblyPipeline(jobId, stepPath, stem)
					sendJson(res, 200, { ok: true, jobId })
				} catch (e) {
					sendJson(res, 500, { error: e.message || '변환 실패' })
				}
			})
			return
		}
		if (req.method === 'GET' && req.url.startsWith('/api/load-step-status')) {
			const full = new URL(req.url, 'http://localhost')
			const jobId = full.searchParams.get('jobId')
			if (!jobId || !jobs.has(jobId)) {
				sendJson(res, 404, { error: '작업을 찾을 수 없습니다.' })
				return
			}
			const job = jobs.get(jobId)
			sendJson(res, 200, {
				ok: true,
				id: job.id,
				status: job.status,
				progress: job.progress,
				message: job.message,
				error: job.error,
				logs: Array.isArray(job.logs) ? job.logs.slice(-24) : [],
				voxelBase: job.voxelBase,
				solidsPath: job.solidsPath,
				assemblyPath: job.assemblyPath,
				assemblyMsgpackPath: job.assemblyMsgpackPath,
				manifestPath: job.solidsPath,
				pipelineVoxelSize: job.pipelineVoxelSize ?? pipelineVoxelSizeMm(),
				gridMeta: job.gridMeta ?? null,
			})
			return
		}
		if (req.method === 'GET' && req.url.startsWith('/api/assembly-data')) {
			const full = new URL(req.url, 'http://localhost')
			const stemRaw = full.searchParams.get('stem') || full.searchParams.get('voxelBase')
			if (!stemRaw) {
				sendJson(res, 400, { error: 'stem 쿼리가 필요합니다.' })
				return
			}
			const abs = assemblyMsgpackAbsPath(stemRaw)
			let st
			try {
				st = fs.statSync(abs)
			} catch {
				res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
				res.end(JSON.stringify({ error: 'assembly msgpack 없음' }))
				return
			}
			if (!st.isFile()) {
				res.writeHead(404)
				res.end('Not Found')
				return
			}
			res.writeHead(200, { 'content-type': 'application/msgpack' })
			fs.createReadStream(abs).pipe(res)
			return
		}
		handleStatic(req, res)
	} catch (e) {
		console.error('Request handling error:', e)
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
		}
		res.end('Internal Server Error')
	}
})

ensureDataLayout()
server.listen(PORT, HOST, () => {
	console.log(`Server running: http://${HOST}:${PORT}`)
	console.log(`Local access: http://localhost:${PORT}`)
	console.log(`Data: step/* | <stem>_solids.json | <stem>_assembly.msgpack`)
	console.log(`Backend: ${PIPELINE_SCRIPT}`)
	console.log(`Pipeline voxel_size: ${pipelineVoxelSizeMm()} mm`)
})
