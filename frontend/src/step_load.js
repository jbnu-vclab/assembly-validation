// ——— STEP 파일 선택·업로드·폴링 ———

export function pickStepFile() {
	return new Promise((resolve, reject) => {
		const input = document.createElement('input')
		input.type = 'file'
		input.accept = '.step,.stp,application/step'
		input.style.display = 'none'
		document.body.appendChild(input)
		input.addEventListener('change', () => {
			const file = input.files?.[0]
			if (!file) {
				document.body.removeChild(input)
				reject(new Error('파일이 선택되지 않았습니다.'))
				return
			}
			resolve(file)
			document.body.removeChild(input)
		})
		input.click()
	})
}

/**
 * @param {string} jobId
 * @param {{ onStatus?: (message: string, meta?: { logs?: string[] }) => void }} [opts]
 */
export async function waitStepBuild(jobId, opts = {}) {
	const { onStatus } = opts
	let lastTickKey = null
	while (true) {
		const statusRes = await fetch(
			`/api/load-step-status?jobId=${encodeURIComponent(jobId)}`,
			{ cache: 'no-store' }
		)
		const statusPayload = await statusRes.json().catch(() => ({}))
		if (!statusRes.ok) {
			throw new Error(
				statusPayload?.error || `변환 상태 조회 실패: ${statusRes.status}`
			)
		}
		const message = statusPayload?.message || '변환 중...'
		const logs = Array.isArray(statusPayload?.logs) ? statusPayload.logs : []
		const tail = logs.length ? logs[logs.length - 1] : ''
		const tickKey = `${message}|${logs.length}|${tail}`
		if (onStatus && tickKey !== lastTickKey) {
			lastTickKey = tickKey
			onStatus(message, { logs })
		}
		if (statusPayload?.status === 'done') return statusPayload
		if (statusPayload?.status === 'failed') {
			throw new Error(statusPayload?.error || '변환 실패')
		}
		await new Promise((r) => setTimeout(r, 150))
	}
}

/**
 * @param {File} file
 * @param {{ onStatus?: (message: string, meta?: { logs?: string[] }) => void }} [opts]
 */
export async function uploadAndBuildFromStep(file, opts = {}) {
	const arrayBuffer = await file.arrayBuffer()
	const res = await fetch('/api/load-step', {
		method: 'POST',
		headers: {
			'content-type': 'application/octet-stream',
			'x-file-name': encodeURIComponent(file.name),
		},
		body: arrayBuffer,
	})
	const payload = await res.json().catch(() => ({}))
	if (!res.ok) {
		throw new Error(payload?.error || `변환 실패: ${res.status}`)
	}
	const jobId = payload?.jobId
	if (!jobId) {
		throw new Error('작업 ID를 받지 못했습니다.')
	}
	return waitStepBuild(jobId, opts)
}

// ——— 변환 상태 문구용 말줄임 애니 ———

/**
 * 서버/로컬 메시지 끝의 점·공백·말줄임(…)을 제거해 애니메이션 베이스로 씀.
 */
export function stripTrailingProgressDots(s) {
	return String(s)
		.replace(/[\u2026…]/g, '')
		.replace(/[.]+$/u, '')
		.replace(/\s+$/u, '')
		.trim()
}

/**
 * @param {(text: string) => void} setText — DOM 등에 반영
 * @returns {{ start: (baseText: string) => void, stop: () => void, setFinal: (text: string) => void }}
 */
export function createEllipsisAnimator(setText) {
	let intervalId = null
	let tickCount = 0
	let currentBase = ''

	function tick() {
		const n = (tickCount % 3) + 1
		tickCount += 1
		const dots = '.'.repeat(n)
		setText(`${currentBase} ${dots}`)
	}

	return {
		start(baseText) {
			if (intervalId != null) {
				clearInterval(intervalId)
				intervalId = null
			}
			currentBase = stripTrailingProgressDots(baseText)
			tickCount = 0
			tick()
			intervalId = setInterval(tick, 450)
		},
		stop() {
			if (intervalId != null) {
				clearInterval(intervalId)
				intervalId = null
			}
		},
		setFinal(text) {
			if (intervalId != null) {
				clearInterval(intervalId)
				intervalId = null
			}
			setText(text)
		},
	}
}
