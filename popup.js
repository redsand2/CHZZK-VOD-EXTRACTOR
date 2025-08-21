// ===== 유틸 =====
function parseHmsToMs(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  let h = 0, m = 0, sec = 0;
  if (parts.length === 3) [h, m, sec] = parts;
  else if (parts.length === 2) [m, sec] = parts;
  else [sec] = parts;
  return ((h * 3600) + (m * 60) + sec) * 1000;
}

// 진행률 바
const progressBarEl = document.getElementById('progressBar');
const progressBarFillEl = document.getElementById('progressBarFill');
const progressBarLabelEl = document.getElementById('progressBarLabel');

function setIndeterminate(on = true) {
  if (!progressBarFillEl) return;
  if (on) {
    progressBarFillEl.classList.add('indeterminate');
    progressBarEl?.removeAttribute('aria-valuenow');
    if (progressBarLabelEl) progressBarLabelEl.textContent = '';
  } else {
    progressBarFillEl.classList.remove('indeterminate');
  }
}

function setProgress(percent) {
  if (!progressBarFillEl || !progressBarEl) return;
  if (typeof percent !== 'number' || Number.isNaN(percent)) {
    setIndeterminate(true);
    return;
  }
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  setIndeterminate(false);
  progressBarFillEl.style.width = `${p}%`;
  progressBarEl.setAttribute('aria-valuenow', String(p));
  if (progressBarLabelEl) progressBarLabelEl.textContent = `${p}%`;
}

function extractVideoId(url) {
  const m = url.match(/video\/(\d+)/);
  return m ? m[1] : null;
}

// ===== 입력값 저장/복원 (chrome.storage) =====
const storage = chrome?.storage?.local ?? null;
const PREF_KEYS = { url: 'vodUrl', start: 'startHms', end: 'endHms' };

async function loadPrefs() {
  try {
    if (!storage) return;
    const obj = await storage.get([PREF_KEYS.url, PREF_KEYS.start, PREF_KEYS.end]);
    const urlEl = document.getElementById('userInput');
    const sEl = document.getElementById('timeStart');
    const eEl = document.getElementById('timeEnd');
    if (urlEl && typeof obj[PREF_KEYS.url] === 'string') urlEl.value = obj[PREF_KEYS.url];
    if (sEl && typeof obj[PREF_KEYS.start] === 'string') sEl.value = obj[PREF_KEYS.start];
    if (eEl && typeof obj[PREF_KEYS.end] === 'string') eEl.value = obj[PREF_KEYS.end];
  } catch (err) {
    console.warn('loadPrefs 실패:', err);
  }
}

function wirePrefAutosave() {
  const urlEl = document.getElementById('userInput');
  const sEl = document.getElementById('timeStart');
  const eEl = document.getElementById('timeEnd');

  urlEl?.addEventListener('input', () => storage?.set({ [PREF_KEYS.url]: urlEl.value.trim() }));
  sEl?.addEventListener('input', () => storage?.set({ [PREF_KEYS.start]: sEl.value.trim() }));
  eEl?.addEventListener('input', () => storage?.set({ [PREF_KEYS.end]: eEl.value.trim() }));
}

(async () => { await loadPrefs(); wirePrefAutosave(); })();

// ===== 메인 흐름(버튼) =====
async function startTask(mode) {
  setIndeterminate(false);
  setProgress(0);
  const input = document.getElementById('userInput');
  const resultDiv = document.getElementById('result');
  const elapsedTextEl = document.getElementById('elapsedTime');
  const btnCsv = document.getElementById('generateBtn');
  const btnJson = document.getElementById('generateJsonBtn');
  const timeStartEl = document.getElementById('timeStart');
  const timeEndEl = document.getElementById('timeEnd');

  const url = input?.value?.trim() || '';
  if (!url) { resultDiv.textContent = 'VOD 주소를 입력해주세요!'; resultDiv.style.color = '#e74c3c'; return; }
  const videoId = extractVideoId(url);
  if (!videoId) { resultDiv.textContent = '유효하지 않은 주소입니다. "https://chzzk.naver.com/video/(숫자)" 형식으로 입력해주세요.'; resultDiv.style.color = '#e74c3c'; return; }

  let startMs = parseHmsToMs(timeStartEl?.value) ?? 0;
  let endMs = parseHmsToMs(timeEndEl?.value);
  endMs = Number.isFinite(endMs) ? endMs : null;
  if (endMs != null && endMs <= startMs) endMs = startMs + 1;

  // 최종 값 저장
  try {
    await storage?.set({
      [PREF_KEYS.url]: url,
      [PREF_KEYS.start]: (timeStartEl?.value?.trim() || ''),
      [PREF_KEYS.end]: (timeEndEl?.value?.trim() || '')
    });
  } catch (e) { console.warn('최종 입력 저장 실패:', e); }

  resultDiv.textContent = `${mode === 'csv' ? 'CSV' : 'JSON'} 생성 작업을 시작합니다...`;
  resultDiv.style.color = '#333';
  if (elapsedTextEl) { elapsedTextEl.style.display = 'none'; elapsedTextEl.textContent = ''; }
  setProgress(0); setIndeterminate(true);
  if (btnCsv) btnCsv.disabled = true;
  if (btnJson) btnJson.disabled = true;

  const startedAt = performance.now();

  // 상태 메시지 리스너
  const onMessage = (msg) => {
    if (msg?.type === 'PROGRESS') {
      setProgress(msg.payload?.percent ?? null);
    } else if (msg?.type === 'COMPLETE') {
      const tEnd = performance.now();
      const sec = Math.round((tEnd - startedAt) / 1000);
      if (elapsedTextEl) { elapsedTextEl.textContent = `총 소요 시간: ${sec}초`; elapsedTextEl.style.display = 'block'; }
      setProgress(100); setIndeterminate(false);
      resultDiv.textContent = `완료! ${msg.payload.mode.toUpperCase()} 파일이 저장되었습니다. (아이템 ${msg.payload.count}개)`;
      resultDiv.style.color = '#2ecc71';
      cleanup();
    } else if (msg?.type === 'ERROR') {
      resultDiv.textContent = `오류: ${msg.payload}`;
      resultDiv.style.color = '#e74c3c';
      cleanup();
    } else if (msg?.type === 'ABORTED') {
      resultDiv.textContent = '작업이 취소되었습니다.';
      resultDiv.style.color = '#e67e22';
      cleanup();
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  function cleanup() {
    if (btnCsv) btnCsv.disabled = false;
    if (btnJson) btnJson.disabled = false;
    chrome.runtime.onMessage.removeListener(onMessage);
  }

  try {
    const res = await chrome.runtime.sendMessage({
      type: mode === 'csv' ? 'START_CSV' : 'START_JSON',
      payload: { videoId, startMs, endMs }
    });
    if (!res?.ok) {
      resultDiv.textContent = `시작 실패: ${res?.error || '알 수 없는 오류'}`;
      resultDiv.style.color = '#e74c3c';
      cleanup();
    }
  } catch (e) {
    resultDiv.textContent = `연결 오류: ${e?.message || e}`;
    resultDiv.style.color = '#e74c3c';
    cleanup();
  }
}

document.getElementById('generateBtn')?.addEventListener('click', () => startTask('csv'));
document.getElementById('generateJsonBtn')?.addEventListener('click', () => startTask('json'));
document.getElementById('userInput')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') startTask('csv'); });

// 팝업 재오픈 시 진행 중이면 상태 복구
(async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    const snap = res?.snapshot;
    if (snap?.running || res?.running) {
      setProgress(snap?.percent ?? null);
      const resultDiv = document.getElementById('result');
      resultDiv.textContent = '백그라운드에서 작업 진행 중...';
      resultDiv.style.color = '#333';
    }
  } catch {}
})();