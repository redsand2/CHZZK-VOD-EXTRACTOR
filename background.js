// background.js (MV3 서비스 워커)
// 권한: "downloads", "storage", host_permissions: "https://api.chzzk.naver.com/*"

let task = {
  running: false,
  mode: null,           // 'csv' | 'json'
  videoId: null,
  startMs: 0,
  endMs: Infinity,
  percent: null,
  got: 0,
  count: 0,
  startedAt: 0,
  fileInfo: null,       // {channelName, openDate}
  aborter: null,
  rawChats: []          // JSON 모드용
};

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const withJitter = (ms) => Math.max(50, Math.round(ms * (0.85 + Math.random() * 0.3)));

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function toYMD(val) {
  try {
    if (!val) return null;
    const d = new Date(val);
    if (!isNaN(d)) {
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    const s = String(val);
    const head = s.includes('T') ? s.split('T')[0] : s;
    return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : null;
  } catch { return null; }
}

async function fetchJsonWithTimeout(url, { timeout = 15000, signal } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: signal || ctrl.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, { retries = 5, baseDelay = 400, factor = 1.8, signal } = {}) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await fetchJsonWithTimeout(url, { timeout: 15000, signal });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          let delay = baseDelay * Math.pow(factor, attempt);
          const ra = res.headers.get('Retry-After');
          if (res.status === 429 && ra && !Number.isNaN(Number(ra))) delay = Number(ra) * 1000;
          await sleep(withJitter(delay));
          attempt++;
          continue;
        }
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelay * Math.pow(factor, attempt);
      await sleep(withJitter(delay));
      attempt++;
    }
  }
}

async function fetchVideoMeta(videoId, signal) {
  const url = `https://api.chzzk.naver.com/service/v2/videos/${videoId}`;
  const data = await fetchWithRetry(url, { signal });
  const content = data?.content ?? {};
  const channelName = content?.channel?.channelName ?? content?.channelName ?? '채널미상';
  const candidates = [content?.openDate, content?.publishDate, content?.publishedAt, content?.createdAt, content?.createdDate, content?.openAt];
  const rawDate = candidates.find(v => typeof v === 'string' && v.length > 0) ?? null;
  const openDate = toYMD(rawDate) ?? '날짜미상';
  return { channelName, openDate };
}

// ===== 저장(서비스 워커: data: URL + 자동 분할) =====
const MAX_DATAURL_BYTES = 20 * 1024 * 1024; // 20MB 임계치
const JSON_CHATS_PER_PART = 50000;          // JSON 파트당 채팅 수(가이드)

function utf8Size(str) { return new TextEncoder().encode(str).length; }
function esc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

async function saveCSV_dataURLSmart(rows, fileInfo) {
  const header = '재생시간,닉네임,메시지\n';
  const bom = '\ufeff';

  // 단일 파일 시도
  let whole = bom + header;
  for (const r of rows) whole += [esc(r.time), esc(r.nickname), esc(r.message)].join(',') + '\n';
  if (utf8Size(whole) <= MAX_DATAURL_BYTES) {
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(whole);
    const filename = `[${fileInfo.openDate}]_${fileInfo.channelName}.csv`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return;
  }

  // 분할 저장
  let part = 1;
  let chunk = bom + header;
  let chunkBytes = utf8Size(chunk);

  const commit = async () => {
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(chunk);
    const filename = `[${fileInfo.openDate}]_${fileInfo.channelName}_p${String(part).padStart(3, '0')}.csv`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    part += 1;
    chunk = bom + header;
    chunkBytes = utf8Size(chunk);
  };

  for (const r of rows) {
    const line = [esc(r.time), esc(r.nickname), esc(r.message)].join(',') + '\n';
    const lineBytes = utf8Size(line);
    if (chunkBytes + lineBytes > MAX_DATAURL_BYTES) await commit();
    chunk += line;
    chunkBytes += lineBytes;
  }
  if (chunkBytes > utf8Size(bom + header)) await commit();
}

function buildJsonPayloadString(template, chatsSlice) {
  const payload = template ? JSON.parse(JSON.stringify(template)) : { content: {} };
  if (!payload.content || typeof payload.content !== 'object') payload.content = {};
  payload.content.videoChats = chatsSlice;
  return JSON.stringify(payload, null, 2);
}

async function saveJSON_dataURLSmart(rawChats, fileInfo, rawTemplate) {
  // 단일 파일 시도
  let jsonStr = buildJsonPayloadString(rawTemplate, rawChats);
  if (utf8Size(jsonStr) <= MAX_DATAURL_BYTES) {
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);
    const filename = `raw_${fileInfo.openDate}_${fileInfo.channelName}.json`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return;
  }

  // 분할 저장
  let part = 1;
  for (let i = 0; i < rawChats.length; i += JSON_CHATS_PER_PART) {
    const slice = rawChats.slice(i, i + JSON_CHATS_PER_PART);
    let partStr = buildJsonPayloadString(rawTemplate, slice);

    // 파트가 너무 크면 보수적으로 더 쪼갬
    while (utf8Size(partStr) > MAX_DATAURL_BYTES && slice.length > 1) {
      const half = Math.max(1, Math.floor(slice.length / 2));
      slice.length = half;
      partStr = buildJsonPayloadString(rawTemplate, slice);
    }

    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(partStr);
    const filename = `raw_${fileInfo.openDate}_${fileInfo.channelName}_p${String(part).padStart(3, '0')}.json`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    part += 1;
  }
}

// ===== 접두어 빌드(미션/영상/구독/구독권 선물) =====
function buildMessagePrefixAndNickname(chat) {
  const tags = [];
  let nicknameOverride = null;
  let extrasObj = null;
  try { if (chat.extras) extrasObj = JSON.parse(chat.extras); } catch {}

  const mt = chat?.messageTypeCode;
  const amount = extrasObj?.payAmount;
  let payType = extrasObj?.payType || '치즈';
  if (payType === 'CURRENCY') payType = '치즈';

  const donationTypeRaw = (extrasObj?.donationType ?? extrasObj?.DonationType ?? '')
    .toString().trim().toUpperCase();

  if (mt === 10) {
    const isMission = donationTypeRaw === 'MISSION' || donationTypeRaw === 'MISSION_PARTICIPATION';
    if (isMission) {
      const missionType = (extrasObj?.missionDonationType ?? extrasObj?.MissionDonationType ?? '')
        .toString().trim().toUpperCase();
      const missionTag = missionType === 'PARTICIPATION' ? '미션 후원-쌓기' : '미션 후원-개설';
      if (amount != null) tags.push(`[${missionTag} ${amount}${payType}]`);
      else tags.push(`[${missionTag}]`);
    } else if (donationTypeRaw === 'VIDEO') {
      if (amount != null) tags.push(`[영상 후원 ${amount}${payType}]`);
      else tags.push(`[영상 후원]`);
    } else {
      if (amount != null) tags.push(`[후원 ${amount}${payType}]`);
      else tags.push(`[후원]`);
    }
  }

  if (mt === 11) {
    let months =
      extrasObj?.month ?? extrasObj?.subscribeMonth ?? extrasObj?.subscriptionMonth ??
      extrasObj?.periodMonth ?? extrasObj?.months;
    if (!months) {
      try {
        const profile = chat.profile ? JSON.parse(chat.profile) : null;
        months = profile?.streamingProperty?.subscription?.accumulativeMonth;
      } catch {}
    }
    tags.push(months ? `[${months}개월 구독]` : `[구독]`);
  }

  if (mt === 12) {
    const qty = Number(extrasObj?.quantity ?? 0);
    const receiver =
      extrasObj?.receiverNickname ??
      extrasObj?.receiverUserNickname ??
      extrasObj?.receiverNick ??
      extrasObj?.receiverName ??
      null;
    if (qty >= 2) tags.push(`[구독권 선물 x${qty}]`);
    else if (receiver) tags.push(`[구독권 선물] ${receiver}`);
    else tags.push(`[구독권 선물]`);
  }

  if (extrasObj?.isAnonymous === true || chat.userIdHash === 'anonymous') {
    nicknameOverride = '익명의 후원자';
  }

  return { prefix: tags.join(' '), nicknameOverride };
}

// ===== 메인 수집 루프 =====
async function runTask({ mode, videoId, startMs, endMs }) {
  task.running = true;
  task.mode = mode;
  task.videoId = videoId;
  task.startMs = startMs ?? 0;
  task.endMs = Number.isFinite(endMs) ? endMs : Infinity;
  task.percent = null;
  task.got = 0;
  task.count = 0;
  task.startedAt = Date.now();
  task.aborter = new AbortController();
  task.rawChats = [];

  // 파일명용 메타
  try { task.fileInfo = await fetchVideoMeta(videoId, task.aborter.signal); }
  catch {
    const d = new Date(); const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    task.fileInfo = { channelName: '채널미상', openDate: `${y}-${m}-${day}` };
  }

  // CSV 모드 누적, JSON 템플릿
  const csvRows = [];
  let rawTemplate = null;

  // 페이지네이션/백오프/스톨
  const BASE_PAGE_DELAY = 150;
  const MAX_EMPTY_RETRY = 3;
  const MAX_STALL_RETRY = 3;
  const STALL_JUMP_MS = 1000;

  const resTimes = [];
  const updateDelay = (base) => {
    const n = resTimes.length; if (n === 0) return base;
    const avg = resTimes.reduce((a,b)=>a+b,0)/n;
    if (avg < 200) return 120; if (avg < 400) return 150; if (avg < 600) return 200; return 300;
  };

  const hasEnd = Number.isFinite(task.endMs);
  let ti = Math.max(0, task.startMs | 0);
  let emptyRetry = 0;
  let lastProgressTime = task.startMs - 1;
  let stallRetry = 0;
  let page = 0;
  let pageDelay = BASE_PAGE_DELAY;

  const sendProgress = () => {
    chrome.runtime.sendMessage({ type: 'PROGRESS', payload: { percent: task.percent, got: task.got, count: task.count } }).catch(()=>{});
    chrome.storage.session.set({ taskSnapshot: { running: task.running, percent: task.percent, got: task.got, count: task.count } });
  };

  try {
    while (true) {
      const apiUrl = `https://api.chzzk.naver.com/service/v1/videos/${videoId}/chats?playerMessageTime=${ti}`;
      const t0 = performance.now();
      const data = await fetchWithRetry(apiUrl, { signal: task.aborter.signal });
      const t1 = performance.now();
      const resTime = t1 - t0;
      resTimes.push(resTime); if (resTimes.length > 5) resTimes.shift();

      const chats = data?.content?.videoChats || [];

      // JSON 템플릿(첫 페이지 상단 구조 보존)
      if (mode === 'json' && !rawTemplate) {
        try {
          const contentMeta = {};
          if (data?.content && typeof data.content === 'object') {
            for (const k of Object.keys(data.content)) if (k !== 'videoChats') contentMeta[k] = data.content[k];
          }
          rawTemplate = {
            ...Object.fromEntries(Object.entries(data || {}).filter(([k]) => k !== 'content')),
            content: contentMeta
          };
        } catch { rawTemplate = { content: {} }; }
      }

      if (chats.length === 0) {
        emptyRetry++;
        if (emptyRetry >= MAX_EMPTY_RETRY) break;
        await sleep(withJitter(Math.max(pageDelay, 500)));
        continue;
      }
      emptyRetry = 0;

      let pageMaxTime = -1;
      for (const chat of chats) {
        const pm = chat.playerMessageTime ?? 0;
        pageMaxTime = Math.max(pageMaxTime, pm);
        if (pm < task.startMs || (hasEnd && pm > task.endMs)) continue;

        // JSON 모드: 원본 합치기
        if (mode === 'json') task.rawChats.push(chat);

        // CSV 모드: 메시지 가공
        if (mode === 'csv') {
          // 닉네임
          let nickname = '알 수 없는 사용자';
          try {
            if (chat.profile) {
              const profileObj = JSON.parse(chat.profile);
              nickname = profileObj?.nickname || nickname;
            }
          } catch {}
          if (chat.userIdHash === 'SYSTEM_MESSAGE') nickname = 'SYSTEM';

          // 본문
          let message = chat.content || '';
          if (chat.messageStatusType === 'CBOTBLIND') message = '클린봇이 부적절한 표현을 감지했습니다';

          // 접두어
          const { prefix, nicknameOverride } = buildMessagePrefixAndNickname(chat);
          if (nicknameOverride) nickname = nicknameOverride;
          const combinedMessage = prefix ? `${prefix} ${message}` : message;

          csvRows.push({ time: formatTime(pm), nickname, message: combinedMessage });
        }
      }

      // 진행률
      if (hasEnd) {
        const progressedMs = Math.max(0, Math.min(pageMaxTime, task.endMs) - task.startMs);
        const totalMs = task.endMs - task.startMs;
        task.percent = Math.max(0, Math.min(100, Math.floor((progressedMs / totalMs) * 100)));
      } else {
        task.percent = task.percent ?? null;
      }
      task.got = chats.length;
      task.count = (mode === 'csv' ? csvRows.length : task.rawChats.length);
      sendProgress();

      const last = chats[chats.length - 1];
      const lastTime = last?.playerMessageTime;
      if (typeof lastTime !== 'number') break;

      if (lastTime === lastProgressTime) {
        stallRetry++;
        if (stallRetry >= MAX_STALL_RETRY) { ti = lastTime + STALL_JUMP_MS; stallRetry = 0; }
        else ti = lastTime + 1;
      } else {
        ti = lastTime + 1;
        lastProgressTime = lastTime;
        stallRetry = 0;
      }

      if (hasEnd && lastProgressTime >= task.endMs) break;

      pageDelay = updateDelay(BASE_PAGE_DELAY);
      page++;
      await sleep(withJitter(pageDelay));
    }

    // 저장
    if (mode === 'csv') await saveCSV_dataURLSmart(csvRows, task.fileInfo);
    else await saveJSON_dataURLSmart(task.rawChats, task.fileInfo, rawTemplate);

    task.percent = 100;
    sendProgress();

    chrome.runtime.sendMessage({
      type: 'COMPLETE',
      payload: {
        mode,
        count: (mode === 'csv' ? csvRows.length : task.rawChats.length),
        fileInfo: task.fileInfo
      }
    }).catch(()=>{});

  } catch (err) {
    if (err?.name === 'AbortError') {
      chrome.runtime.sendMessage({ type: 'ABORTED' }).catch(()=>{});
    } else {
      chrome.runtime.sendMessage({ type: 'ERROR', payload: String(err?.message || err) }).catch(()=>{});
    }
  } finally {
    task.running = false;
    task.mode = null;
    task.aborter = null;
    chrome.storage.session.set({ taskSnapshot: { running: false, percent: task.percent, got: task.got, count: task.count } });
  }
}

// ===== 메시지 라우팅 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'START_CSV' || msg?.type === 'START_JSON') {
        if (task.running) throw new Error('이미 작업이 진행 중입니다.');
        await runTask({
          mode: msg.type === 'START_CSV' ? 'csv' : 'json',
          videoId: msg.payload.videoId,
          startMs: msg.payload.startMs ?? 0,
          endMs: Number.isFinite(msg.payload.endMs) ? msg.payload.endMs : Infinity
        });
      } else if (msg?.type === 'GET_STATUS') {
        const snap = await chrome.storage.session.get('taskSnapshot');
        sendResponse({
          ok: true,
          running: task.running,
          percent: task.percent,
          got: task.got,
          count: task.count,
          snapshot: snap?.taskSnapshot ?? null
        });
        return;
      } else if (msg?.type === 'ABORT') {
        if (task.running && task.aborter) task.aborter.abort();
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async sendResponse
});