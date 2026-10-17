/* ══════════════════════════════════════════════════════════════
 * easymap.js — 「地籍圖資網路便民服務系統」截圖匯入
 *
 * 用法：在 https://easymap.land.moi.gov.tw 查好地號後，截取左側「土地」資料表
 *       （Win：Win+Shift+S；Mac：Cmd+Ctrl+Shift+4），回到磚家計算：
 *         - 直接按 Ctrl+V（任何分頁都可以），或
 *         - 點上方「截圖匯入」按鈕，或
 *         - 在「匯入謄本」頁把圖片拖進來 / 點擊選擇圖片
 *       系統用 Google Vision 辨識後，跳出確認視窗，可修正後再匯入。
 *
 * 會帶入：地號、面積、公告現值（→ 當期公告現值）、公告地價、行政區、地段、公告年度
 *   - 地號已存在 → 更新面積與當期公告現值，並重算該地號的增值稅
 *   - 地號不存在 → 新增地號，並開啟編輯視窗讓你補所有權人
 *
 * 依賴（皆在 script.js）：callGoogleVisionRaw、autoCalcAllTaxSilent、show、openEditModal
 * ══════════════════════════════════════════════════════════════ */
(function (global) {
'use strict';

// ──────────────────────────────────────────────────────────────
// 1. 文字正規化
// ──────────────────────────────────────────────────────────────

const CJK = '\\u4e00-\\u9fa5';

function toHalfWidth(s) {
    return String(s == null ? '' : s)
        .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/　/g, ' ');
}

/** OCR 文字清理：全形轉半形、修正被拆開的小數點/千分位、移除中文字之間的空白（不動換行） */
function normalizeOcrText(s) {
    return toHalfWidth(s)
        .replace(/\r/g, '')
        .replace(/(\d) *[.·] *(?=\d)/g, '$1.')
        .replace(/(\d) *, *(?=\d{3}(?!\d))/g, '$1,')
        .replace(new RegExp(`([${CJK}]) +(?=[${CJK}])`, 'g'), '$1')
        .replace(/[ \t]+/g, ' ');
}

function parseNum(s) {
    if (s == null) return null;
    const n = parseFloat(String(s).replace(/,/g, ''));
    return isFinite(n) ? n : null;
}

// ──────────────────────────────────────────────────────────────
// 2. 地號格式
//    地籍圖資：00100000（前 4 碼母號、後 4 碼子號）
//    謄本：0010-0000；一般寫法：10、10-1
// ──────────────────────────────────────────────────────────────

const pad4 = n => String(n).padStart(4, '0');

function normalizeLandNo(raw) {
    const s = toHalfWidth(raw).replace(/\s+/g, '').replace(/地號$/, '');
    let m, main, sub = 0;
    if ((m = s.match(/^(\d{4})(\d{4})$/)))            { main = +m[1]; sub = +m[2]; }
    else if ((m = s.match(/^(\d{1,5})[-之](\d{1,4})$/))) { main = +m[1]; sub = +m[2]; }
    else if ((m = s.match(/^(\d{1,5})$/)))              { main = +m[1]; }
    else return null;
    if (!main) return null;
    return {
        main, sub,
        short: sub ? `${main}-${sub}` : `${main}`,
        long: `${pad4(main)}-${pad4(sub)}`
    };
}

/** 在目前專案中找出同一筆地號（不論是 10、0010-0000 或 00100000 的寫法） */
function findLandKey(norm, dataObj) {
    const d = dataObj || global.data || {};
    if (!norm) return null;
    return Object.keys(d).find(k => {
        const n = normalizeLandNo(k);
        return n && n.short === norm.short;
    }) || null;
}

function findLandKeyByText(text, dataObj) {
    return findLandKey(normalizeLandNo(text), dataObj);
}

/** 新地號的 key：沿用專案既有的寫法（若已有 0010-0000 格式的地號就用同格式） */
function makeLandKey(norm, dataObj) {
    const d = dataObj || global.data || {};
    const usesLong = Object.keys(d).some(k => /^\d{4}-\d{4}$/.test(k));
    return usesLong ? norm.long : norm.short;
}

// ──────────────────────────────────────────────────────────────
// 3. Google Vision 回傳 → 依畫面位置重組成「列」
//    （避免 Vision 把表格的標籤欄、數值欄拆成不同區塊，導致順序錯亂）
// ──────────────────────────────────────────────────────────────

function visionToLines(ann) {
    const items = ((ann && ann.textAnnotations) || []).slice(1);
    const words = [];
    for (const w of items) {
        const vs = (w.boundingPoly && w.boundingPoly.vertices) || [];
        if (!w.description || vs.length === 0) continue;
        const xs = vs.map(v => v.x || 0), ys = vs.map(v => v.y || 0);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        words.push({ text: w.description, x0, x1, cy: (y0 + y1) / 2, h: Math.max(1, y1 - y0) });
    }
    if (!words.length) return [];

    words.sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const w of words) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(w.cy - last.cy) <= Math.min(last.h, w.h) * 0.5) {
            last.words.push(w);
            last.cy = (last.cy * (last.words.length - 1) + w.cy) / last.words.length;
            last.h = Math.max(last.h, w.h);
        } else {
            rows.push({ cy: w.cy, h: w.h, words: [w] });
        }
    }

    return rows.map(r => {
        r.words.sort((a, b) => a.x0 - b.x0);
        let out = '';
        r.words.forEach((w, i) => {
            if (i > 0) {
                const gap = w.x0 - r.words[i - 1].x1;
                out += gap > r.h * 0.35 ? ' ' : '';
            }
            out += w.text;
        });
        return out;
    });
}

// ──────────────────────────────────────────────────────────────
// 4. 解析地籍資料
// ──────────────────────────────────────────────────────────────

const NUM = '(\\d[\\d,]*(?:\\.\\d+)?)';
const UNIT_M2 = '(?:平方公尺|平方公R|㎡|m ?[²2])';
const PER_M2 = `元 ?[/|lI1]? ?${UNIT_M2}`;
const SEC_NAME = `([${CJK}]{1,8}?段(?:[${CJK}]{1,4}?小段)?)`;
const COUNTY = `([${CJK}]{1,3}?[市縣])`;
const TOWN = `([${CJK}]{1,4}?[區鄉鎮市])`;

function firstMatch(re, texts) {
    for (const t of texts) {
        if (!t) continue;
        const m = t.match(re);
        if (m) return m;
    }
    return null;
}

/**
 * @param {string} lineText  依位置重組後的文字（每列一行），優先使用
 * @param {string} fullText  Vision 原始全文，作為備援
 */
function parseEasymapText(lineText, fullText) {
    const lines = normalizeOcrText(lineText);
    const full = normalizeOcrText(fullText);
    const texts = [lines, full];

    const r = {
        landNo: '', area: null, currentValue: null, landPrice: null,
        sectionCode: '', sectionName: '', county: '', town: '', year: null
    };
    let m;

    // ── 地號 ──
    if ((m = firstMatch(/地號 ?:? ?(\d{8})(?!\d)/, texts)) ||
        (m = firstMatch(/(?:^|\D)(\d{8})(?!\d)/, texts))) {
        const n = normalizeLandNo(m[1]);
        if (n) r.landNo = n.short;
    }
    if (!r.landNo && (m = firstMatch(/(?:^|\D)(\d{4}-\d{4})(?!\d)/, texts))) {
        const n = normalizeLandNo(m[1]);
        if (n) r.landNo = n.short;
    }
    if (!r.landNo && (m = firstMatch(/段 ?(\d{1,4}(?:-\d{1,4})?) ?地號/, texts))) {
        const n = normalizeLandNo(m[1]);
        if (n) r.landNo = n.short;
    }
    if (!r.landNo && (m = firstMatch(/地號 ?:? ?(\d{1,4}(?:-\d{1,4})?)(?![\d.])/, texts))) {
        const n = normalizeLandNo(m[1]);
        if (n) r.landNo = n.short;
    }

    // ── 面積（m²）──
    if ((m = firstMatch(new RegExp(`面積 ?:? ?${NUM}`), texts)) ||
        (m = firstMatch(new RegExp(`${NUM} ?${UNIT_M2}`), texts))) {
        r.area = parseNum(m[1]);
    }

    // ── 公告現值 / 公告地價（元/m²）──
    if ((m = firstMatch(new RegExp(`公告(?:土地)?現值 ?:? ?${NUM} ?元`), texts))) r.currentValue = parseNum(m[1]);
    if ((m = firstMatch(new RegExp(`公告地價 ?:? ?${NUM} ?元`), texts)))        r.landPrice    = parseNum(m[1]);

    if (r.currentValue == null || r.landPrice == null) {
        // 標籤沒辨識到 → 依畫面順序：第一個「元/平方公尺」是公告現值，第二個是公告地價
        const src = lines.trim() ? lines : full;
        const vals = [...src.matchAll(new RegExp(`${NUM} ?${PER_M2}`, 'g'))].map(x => parseNum(x[1]));
        const byLabelCur = r.currentValue != null, byLabelPrice = r.landPrice != null;
        if (byLabelCur) { const i = vals.indexOf(r.currentValue); if (i >= 0) vals.splice(i, 1); }
        if (byLabelPrice) { const i = vals.indexOf(r.landPrice); if (i >= 0) vals.splice(i, 1); }
        if (r.currentValue == null && vals.length) r.currentValue = vals.shift();
        if (r.landPrice == null && vals.length) r.landPrice = vals.shift();
        // 兩個都靠順序猜的：公告土地現值幾乎一定高於公告地價，順序反了就對調
        if (!byLabelCur && !byLabelPrice && r.currentValue != null && r.landPrice != null && r.currentValue < r.landPrice) {
            [r.currentValue, r.landPrice] = [r.landPrice, r.currentValue];
        }
    }

    // ── 地段 ──
    if ((m = firstMatch(new RegExp(`地段 ?:? ?(\\d{4})? ?${SEC_NAME}`), texts))) {
        r.sectionCode = m[1] || '';
        r.sectionName = m[2];
    }
    if (!r.sectionName && (m = firstMatch(new RegExp(`(?:^|\\n)(\\d{4}) ?${SEC_NAME} ?(?=\\n|$)`), texts))) {
        r.sectionCode = m[1]; r.sectionName = m[2];          // 表格值單獨成一行：「0125 工建段」
    }
    if (!r.sectionCode && (m = firstMatch(/段號\s*:?\s*(\d{4})/, texts))) r.sectionCode = m[1];
    if (!r.sectionName && (m = firstMatch(new RegExp(`段名\\s*:?\\s*${SEC_NAME}`), texts))) r.sectionName = m[1];
    if (!r.sectionName && (m = firstMatch(new RegExp(`(\\d{4}) ?${SEC_NAME} ?\\d{1,4}(?:-\\d{1,4})? ?地號`), texts))) {
        r.sectionCode = r.sectionCode || m[1];               // 地圖上的標籤：「…0125工建段10地號」
        r.sectionName = m[2];
    }

    // ── 行政區 ──
    if ((m = firstMatch(new RegExp(`行政區 ?:? ?${COUNTY} ?${TOWN}`), texts)) ||
        (m = firstMatch(new RegExp(`(?:^|\\n)${COUNTY} ?${TOWN} ?(?=\\n|$)`), texts))) {
        r.county = m[1]; r.town = m[2];
    } else {
        if ((m = firstMatch(new RegExp(`縣市\\s*:?\\s*${COUNTY}`), texts))) r.county = m[1];
        if ((m = firstMatch(new RegExp(`鄉鎮市區\\s*:?\\s*${TOWN}`), texts))) r.town = m[1];
        if ((!r.county || !r.town) && (m = firstMatch(new RegExp(`${COUNTY}${TOWN}\\d{4}`), texts))) {
            r.county = r.county || m[1]; r.town = r.town || m[2];
        }
    }

    // ── 公告年度（頁面下方「…為115年度資料」）──
    if ((m = firstMatch(/(\d{2,3}) ?年度/, texts))) r.year = parseInt(m[1], 10);

    return r;
}

// ──────────────────────────────────────────────────────────────
// 5. 寫入專案資料
// ──────────────────────────────────────────────────────────────

function createEmptyLand() {
    return {
        "所有權人": [],
        "土地面積": { "面積": 0, "權利範圍": [] },
        "他項權利": "",
        "公告現值": [], "年月": [],
        "當期公告現值": 0,
        "增值稅預估(自用)": [], "增值稅預估(一般)": [],
        "建號": [], "建物門牌": [], "樓層": [], "建物面積": [],
        "附屬建物用途": [], "附屬建物面積": [],
        "權利範圍": [], "所有權地址": [], "電話": "",
        "增值稅試算(自用)": [], "增值稅試算(一般)": [],
        "使用分區": "商", "基準容積率": 4.4, "建蔽率": 0.7
    };
}

const fmtNum = (n, d = 2) => (n == null || n === '' || isNaN(n)) ? '—'
    : Number(n).toLocaleString('zh-TW', { maximumFractionDigits: d });

async function applyImport(v) {
    const data = global.data;
    const norm = normalizeLandNo(v.landNo);
    if (!norm) throw new Error('地號格式不正確');

    let key = findLandKey(norm, data);
    const isNew = !key;
    if (isNew) {
        key = makeLandKey(norm, data);
        data[key] = createEmptyLand();
    }
    const rec = data[key];
    const changes = [];

    if (v.area > 0) {
        const old = parseFloat(rec['土地面積']['面積']) || 0;
        if (Math.abs(old - v.area) > 1e-9) {
            rec['土地面積']['面積'] = v.area;
            if (!isNew) changes.push(`面積 ${fmtNum(old)} → ${fmtNum(v.area)} m²`);
        }
    }
    if (v.currentValue > 0) {
        const old = parseFloat(rec['當期公告現值']) || 0;
        if (Math.abs(old - v.currentValue) > 1e-9) {
            rec['當期公告現值'] = v.currentValue;
            if (!isNew) changes.push(`當期公告現值 ${fmtNum(old, 0)} → ${fmtNum(v.currentValue, 0)}`);
        }
    }

    rec['地籍資料'] = Object.assign({}, rec['地籍資料'] || {}, {
        行政區: [v.county, v.town].filter(Boolean).join(' '),
        段號: v.sectionCode || '',
        地段: v.sectionName || '',
        公告地價: v.landPrice > 0 ? v.landPrice : '',
        公告年度: v.year || '',
        匯入時間: new Date().toISOString()
    });

    // 現值或面積有變 → 重算這筆地號的增值稅（只動這一筆）
    let taxCount = 0;
    if (!isNew && changes.length && (rec['所有權人'] || []).length && typeof global.autoCalcAllTaxSilent === 'function') {
        try { taxCount = await global.autoCalcAllTaxSilent([key]) || 0; } catch (e) { console.warn(e); }
    }

    // 專案還叫「未命名專案」→ 改成「七堵區工建段」
    if (v.renameTo) {
        const titleEl = document.getElementById('title');
        if (titleEl) {
            titleEl.value = v.renameTo;
            titleEl.dispatchEvent(new Event('change'));
        }
    }

    if (typeof global.saveProjectToLocal === 'function') global.saveProjectToLocal();
    return { key, isNew, changes, taxCount };
}

// ──────────────────────────────────────────────────────────────
// 6. UI：樣式、提示、處理佇列、確認視窗
// ──────────────────────────────────────────────────────────────

function injectStyles() {
    if (document.getElementById('easymap-styles')) return;
    const st = document.createElement('style');
    st.id = 'easymap-styles';
    st.textContent = `
        .em-toast-wrap { position:fixed; left:50%; bottom:60px; transform:translateX(-50%); z-index:3000; display:flex; flex-direction:column; gap:8px; align-items:center; pointer-events:none; }
        .em-toast { background:#1a1a2e; color:#fff; padding:10px 18px; border-radius:10px; font-size:13px; line-height:1.5; box-shadow:0 6px 20px rgba(0,0,0,0.25); max-width:min(560px, 92vw); animation:emToastIn .25s ease; pointer-events:auto; }
        .em-toast.ok   { border-left:4px solid #10b981; }
        .em-toast.warn { border-left:4px solid #f59e0b; }
        .em-toast.err  { border-left:4px solid #ef4444; }
        @keyframes emToastIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:none; } }
        @keyframes emSpin { to { transform:rotate(360deg); } }
        .em-spinner { width:34px; height:34px; border:3px solid #ede8ff; border-top-color:var(--accent-purple,#7d2ae8); border-radius:50%; animation:emSpin .8s linear infinite; }
        .em-preview { width:100%; max-height:150px; object-fit:contain; object-position:left top; border:1px solid #eee; border-radius:8px; background:#fafafa; }
        .em-chips { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 4px; }
        .em-chip { font-size:12px; background:#f4efff; color:var(--accent-purple,#7d2ae8); padding:3px 10px; border-radius:20px; font-weight:600; }
        .em-banner { border-radius:8px; padding:10px 12px; font-size:13px; margin:12px 0 18px; line-height:1.55; }
        .em-banner.new    { background:#e8f8f1; color:#11704a; border:1px solid #b6e8d1; }
        .em-banner.update { background:#f4efff; color:#5b1fb0; border:1px solid #dccaf9; }
        .em-banner.warn   { background:#fff8e1; color:#8a5a00; border:1px solid #ffe08a; }
        .em-old { font-size:11px; color:#999; margin-top:4px; min-height:14px; }
        .em-old.diff { color:#c2410c; font-weight:600; }
        .em-raw summary { cursor:pointer; font-size:12px; color:#999; margin-top:14px; }
        .em-raw pre { white-space:pre-wrap; font-size:11px; color:#666; background:#f6f6f6; padding:10px; border-radius:6px; max-height:160px; overflow:auto; margin-top:6px; }
        .em-zone { border:2px dashed #cdeff0; border-radius:14px; padding:22px 18px; text-align:center; cursor:pointer; transition:all .25s; background:#f7fdfd; display:flex; flex-direction:column; align-items:center; gap:8px; outline:none; }
        .em-zone:hover, .em-zone:focus-visible, .em-zone.drag { border-color:#00c4cc; background:#ecfbfb; }
        .em-zone i { font-size:26px; color:#00b3ba; }
        .em-zone kbd { background:#fff; border:1px solid #ccc; border-bottom-width:2px; border-radius:4px; padding:0 5px; font-size:11px; font-family:inherit; }
        .btn-paste-shot { background:rgba(255,255,255,0.18) !important; border:1px solid rgba(255,255,255,0.4) !important; box-shadow:none !important; }
        .btn-paste-shot:hover { background:rgba(255,255,255,0.3) !important; }
    `;
    document.head.appendChild(st);
}

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, type = 'ok', ms = 4500) {
    injectStyles();
    let wrap = document.querySelector('.em-toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'em-toast-wrap'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = `em-toast ${type}`;
    t.innerHTML = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
}

function getApiKey() {
    const inp = document.getElementById('gv-key-input');
    let key = (inp && inp.value || '').trim();
    if (key) { try { localStorage.setItem('gv_api_key', key); } catch (e) {} return key; }
    try { key = (localStorage.getItem('gv_api_key') || '').trim(); } catch (e) { key = ''; }
    return key;
}

function isEditModalOpen() {
    const m = document.getElementById('editModal');
    return !!(m && m.style.display !== 'none' && m.style.display !== '');
}

/** 圖片前處理：太小放大（提高辨識率）、太大縮小（避免超過 API 上限），轉 base64 */
async function prepareImage(blob) {
    let src;
    if (global.createImageBitmap) {
        src = await createImageBitmap(blob);
    } else {
        src = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('無法讀取圖片'));
            img.src = URL.createObjectURL(blob);
        });
    }
    const w = src.width, h = src.height;
    if (!w || !h) throw new Error('圖片是空的');
    const maxDim = Math.max(w, h);
    let scale = 1;
    if (maxDim > 4000) scale = 4000 / maxDim;
    else if (w < 1000 && maxDim * 2 <= 4000) scale = 2;

    const cvs = document.createElement('canvas');
    cvs.width = Math.round(w * scale);
    cvs.height = Math.round(h * scale);
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, cvs.width, cvs.height);
    if (src.close) src.close();

    let url = cvs.toDataURL('image/png');
    if (url.length > 7e6) url = cvs.toDataURL('image/jpeg', 0.92);
    return url.split(',')[1];
}

// ── 遮罩視窗（辨識中 → 確認） ──
function getOverlay() {
    injectStyles();
    let ov = document.getElementById('easymapOverlay');
    if (!ov) {
        ov = document.createElement('div');
        ov.id = 'easymapOverlay';
        ov.className = 'modal-overlay';
        ov.style.display = 'none';
        document.body.appendChild(ov);
    }
    return ov;
}

function closeOverlay() {
    const ov = document.getElementById('easymapOverlay');
    if (ov) { ov.style.display = 'none'; ov.innerHTML = ''; ov.onkeydown = null; }
}

function showLoading(previewUrl, remaining) {
    const ov = getOverlay();
    ov.innerHTML = `
        <div class="modal-content" style="width:420px;">
            <div class="modal-body" style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:30px;">
                <div class="em-spinner"></div>
                <div style="font-weight:700;color:#333;">辨識地籍截圖中…</div>
                ${remaining ? `<div style="font-size:12px;color:#999;">之後還有 ${remaining} 張</div>` : ''}
                <img class="em-preview" src="${previewUrl}" alt="">
            </div>
        </div>`;
    ov.style.display = 'flex';
}

function showError(msg, previewUrl) {
    return new Promise(resolve => {
        const ov = getOverlay();
        ov.innerHTML = `
            <div class="modal-content" style="width:460px;">
                <div class="modal-header"><h3><i class="fa-solid fa-triangle-exclamation" style="color:#e74c3c;"></i> 截圖辨識失敗</h3></div>
                <div class="modal-body">
                    <p style="color:#c0392b;font-size:14px;margin-bottom:12px;">${esc(msg)}</p>
                    ${previewUrl ? `<img class="em-preview" src="${previewUrl}" alt="">` : ''}
                </div>
                <div class="modal-footer"><button class="btn-save" id="em-err-ok">知道了</button></div>
            </div>`;
        ov.style.display = 'flex';
        const ok = document.getElementById('em-err-ok');
        ok.onclick = () => { closeOverlay(); resolve(); };
        ok.focus();
    });
}

/** 確認視窗：回傳 { action: 'import' | 'skip' | 'cancelAll', values } */
function showConfirm(parsed, ctx) {
    return new Promise(resolve => {
        const ov = getOverlay();
        const data = global.data || {};
        const basics = global.basics || {};
        const curTitle = (basics['地段'] || (document.getElementById('title') || {}).value || '').trim();
        const suggestTitle = (parsed.town || '') + (parsed.sectionName || '');
        const canRename = suggestTitle && /^未命名專案/.test(curTitle);
        const missing = [];
        if (!parsed.landNo) missing.push('地號');
        if (parsed.area == null) missing.push('面積');
        if (parsed.currentValue == null) missing.push('公告現值');

        const chips = [
            parsed.county || parsed.town ? `${parsed.county} ${parsed.town}`.trim() : '',
            parsed.sectionName ? `${parsed.sectionCode} ${parsed.sectionName}`.trim() : '',
            parsed.year ? `${parsed.year} 年度公告值` : ''
        ].filter(Boolean).map(c => `<span class="em-chip">${esc(c)}</span>`).join('');

        ov.innerHTML = `
            <div class="modal-content" style="width:560px;">
                <div class="modal-header">
                    <h3><i class="fa-solid fa-map-location-dot" style="color:var(--accent-purple);"></i> 地籍截圖辨識結果</h3>
                    <button class="close-btn" id="em-x" title="取消">&times;</button>
                </div>
                <div class="modal-body">
                    <img class="em-preview" src="${ctx.previewUrl}" alt="">
                    ${chips ? `<div class="em-chips">${chips}</div>` : ''}
                    ${missing.length ? `<div class="em-banner warn">⚠ 沒有辨識到：${missing.join('、')}。請確認截圖包含左側「土地」資料表，或直接在下方手動填寫。</div>` : ''}
                    <div id="em-status" class="em-banner"></div>
                    <div class="grid-2-col">
                        <div class="form-group">
                            <label>地號</label>
                            <input type="text" id="em-landNo" value="${esc(parsed.landNo)}" placeholder="例：10 或 10-1">
                            <div class="em-old" id="em-landNo-old"></div>
                        </div>
                        <div class="form-group">
                            <label>土地面積 (m²)</label>
                            <input type="number" id="em-area" step="0.01" value="${parsed.area != null ? parsed.area : ''}">
                            <div class="em-old" id="em-area-old"></div>
                        </div>
                        <div class="form-group">
                            <label>當期公告現值 (元/m²)</label>
                            <input type="number" id="em-cur" step="1" value="${parsed.currentValue != null ? parsed.currentValue : ''}">
                            <div class="em-old" id="em-cur-old"></div>
                        </div>
                        <div class="form-group">
                            <label>公告地價 (元/m²)</label>
                            <input type="number" id="em-price" step="1" value="${parsed.landPrice != null ? parsed.landPrice : ''}">
                            <div class="em-old">僅供參考，存在地號資料中</div>
                        </div>
                    </div>
                    ${canRename ? `
                    <label style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px;color:#444;cursor:pointer;">
                        <input type="checkbox" id="em-rename" checked style="width:16px;height:16px;accent-color:var(--accent-purple);">
                        專案名稱改為「${esc(suggestTitle)}」
                    </label>` : ''}
                    <details class="em-raw"><summary>辨識原文</summary><pre>${esc(ctx.rawText || '（無）')}</pre></details>
                </div>
                <div class="modal-footer">
                    ${ctx.remaining ? `<button class="btn-cancel" id="em-cancel-all">全部取消</button>` : ''}
                    <button class="btn-cancel" id="em-skip">${ctx.remaining ? '略過這張' : '取消'}</button>
                    <button class="btn-save" id="em-ok"><i class="fa-solid fa-file-import"></i> 匯入${ctx.remaining ? `（還有 ${ctx.remaining} 張）` : ''}</button>
                </div>
            </div>`;
        ov.style.display = 'flex';

        const $ = id => document.getElementById(id);
        const statusEl = $('em-status');

        function refreshStatus() {
            const norm = normalizeLandNo($('em-landNo').value);
            const key = norm ? findLandKey(norm, data) : null;
            const setOld = (id, oldVal, newVal, digits) => {
                const el = $(id);
                if (!key) { el.textContent = ''; el.classList.remove('diff'); return; }
                const changed = newVal !== '' && Math.abs((parseFloat(newVal) || 0) - (parseFloat(oldVal) || 0)) > 1e-9;
                el.textContent = `目前：${fmtNum(oldVal, digits)}${changed ? '（將更新）' : ''}`;
                el.classList.toggle('diff', changed);
            };
            if (!norm) {
                statusEl.className = 'em-banner warn';
                statusEl.textContent = '請輸入地號（例：10、10-1，或 00100000）';
                $('em-ok').disabled = true;
            } else if (key) {
                const owners = (data[key]['所有權人'] || []).length;
                statusEl.className = 'em-banner update';
                statusEl.innerHTML = `將<b>更新</b>既有地號 <b>${esc(key)}</b>（${owners} 位所有權人）${owners ? '，並重新計算這筆地號的增值稅' : ''}`;
                $('em-ok').disabled = false;
            } else {
                statusEl.className = 'em-banner new';
                statusEl.innerHTML = `將<b>新增</b>地號 <b>${esc(makeLandKey(norm, data))}</b>，匯入後可在編輯視窗補上所有權人`;
                $('em-ok').disabled = false;
            }
            if (key) {
                setOld('em-area-old', data[key]['土地面積']['面積'], $('em-area').value, 2);
                setOld('em-cur-old', data[key]['當期公告現值'], $('em-cur').value, 0);
            } else {
                setOld('em-area-old'); setOld('em-cur-old');
            }
        }

        ['em-landNo', 'em-area', 'em-cur'].forEach(id => $(id).addEventListener('input', refreshStatus));
        refreshStatus();

        const finish = action => {
            const values = {
                landNo: $('em-landNo').value.trim(),
                area: parseFloat($('em-area').value),
                currentValue: parseFloat($('em-cur').value),
                landPrice: parseFloat($('em-price').value),
                county: parsed.county, town: parsed.town,
                sectionCode: parsed.sectionCode, sectionName: parsed.sectionName, year: parsed.year,
                renameTo: (canRename && $('em-rename') && $('em-rename').checked) ? suggestTitle : ''
            };
            closeOverlay();
            resolve({ action, values });
        };

        $('em-ok').onclick = () => { if (!$('em-ok').disabled) finish('import'); };
        $('em-skip').onclick = () => finish('skip');
        $('em-x').onclick = () => finish(ctx.remaining ? 'cancelAll' : 'skip');
        if ($('em-cancel-all')) $('em-cancel-all').onclick = () => finish('cancelAll');
        ov.onkeydown = e => {
            if (e.key === 'Escape') { e.preventDefault(); finish(ctx.remaining ? 'cancelAll' : 'skip'); }
            else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); $('em-ok').click(); }
        };
        (parsed.landNo ? $('em-ok') : $('em-landNo')).focus();
    });
}

// ── 處理佇列（一次貼/拖多張也可以）──
const queue = [];
let busy = false;

function handleImageFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f && /^image\//.test(f.type));
    if (!files.length) return;
    if (isEditModalOpen()) {
        toast('請先關閉「編輯地號」視窗，再貼上截圖', 'warn');
        return;
    }
    if (!getApiKey()) {
        toast('請先在「匯入謄本」頁輸入 Google Vision API Key，再貼上截圖', 'warn', 6000);
        const tabA = document.getElementById('A');
        if (tabA && !tabA.classList.contains('active')) tabA.click();
        setTimeout(() => { const k = document.getElementById('gv-key-input'); if (k) k.focus(); }, 50);
        return;
    }
    queue.push(...files);
    if (!busy) processQueue();
}

async function processQueue() {
    busy = true;
    let importedAny = false, lastNewEmptyKey = null;
    try {
        while (queue.length) {
            const file = queue.shift();
            const res = await processOne(file);
            if (!res) continue;
            if (res.action === 'cancelAll') { queue.length = 0; break; }
            if (res.action === 'import') {
                importedAny = true;
                if (res.isNew && !(global.data[res.key]['所有權人'] || []).length) lastNewEmptyKey = res.key;
            }
        }
    } finally {
        busy = false;
    }
    if (importedAny) {
        refreshView();
        if (lastNewEmptyKey && typeof global.openEditModal === 'function') {
            setTimeout(() => global.openEditModal(lastNewEmptyKey), 350);
        }
    }
}

async function processOne(file) {
    const previewUrl = URL.createObjectURL(file);
    try {
        showLoading(previewUrl, queue.length);
        if (typeof global.callGoogleVisionRaw !== 'function') throw new Error('找不到 Google Vision 呼叫函式（請確認 script.js 已更新）');
        const base64 = await prepareImage(file);
        const ann = await global.callGoogleVisionRaw(getApiKey(), base64);
        const lineArr = visionToLines(ann);
        const fullText = (ann && (ann.fullTextAnnotation && ann.fullTextAnnotation.text ||
            ann.textAnnotations && ann.textAnnotations[0] && ann.textAnnotations[0].description)) || '';
        if (!lineArr.length && !fullText.trim()) throw new Error('圖片中沒有辨識到任何文字');

        const parsed = parseEasymapText(lineArr.join('\n'), fullText);
        const choice = await showConfirm(parsed, {
            previewUrl, remaining: queue.length,
            rawText: lineArr.length ? lineArr.join('\n') : fullText
        });
        if (choice.action !== 'import') return { action: choice.action };

        const r = await applyImport(choice.values);
        if (r.isNew) {
            toast(`已新增地號 <b>${esc(r.key)}</b>（面積 ${fmtNum(choice.values.area)} m²、公告現值 ${fmtNum(choice.values.currentValue, 0)}）`, 'ok');
        } else if (r.changes.length) {
            toast(`已更新地號 <b>${esc(r.key)}</b>：${r.changes.map(esc).join('；')}${r.taxCount ? `；已重算 ${r.taxCount} 位所有權人的增值稅` : ''}`, 'ok', 6000);
        } else {
            toast(`地號 <b>${esc(r.key)}</b> 的面積與公告現值都和截圖相同，沒有變更`, 'ok');
        }
        return { action: 'import', key: r.key, isNew: r.isNew };
    } catch (err) {
        console.error('地籍截圖匯入失敗', err);
        await showError(err.message || String(err), previewUrl);
        return { action: 'error' };
    } finally {
        setTimeout(() => URL.revokeObjectURL(previewUrl), 1000);
    }
}

function refreshView() {
    if (typeof global.show !== 'function') return;
    const active = document.querySelector('.nav-item.active');
    let tab = active ? active.id : 'B';
    if (tab === 'A' || tab === 'F') {
        tab = 'B';
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const b = document.getElementById('B');
        if (b) b.classList.add('active');
    }
    global.show(tab);
}

// ── 從剪貼簿讀取（給按鈕用；不支援時改開檔案選擇）──
let filePicker = null;
function pickImageFile() {
    if (!filePicker) {
        filePicker = document.createElement('input');
        filePicker.type = 'file';
        filePicker.accept = 'image/*';
        filePicker.multiple = true;
        filePicker.style.display = 'none';
        filePicker.addEventListener('change', () => { handleImageFiles(filePicker.files); filePicker.value = ''; });
        document.body.appendChild(filePicker);
    }
    filePicker.click();
}

async function importFromClipboard() {
    if (navigator.clipboard && navigator.clipboard.read) {
        try {
            const items = await navigator.clipboard.read();
            const blobs = [];
            for (const it of items) {
                const type = it.types.find(t => t.startsWith('image/'));
                if (type) {
                    const b = await it.getType(type);
                    blobs.push(new File([b], 'clipboard.png', { type }));
                }
            }
            if (blobs.length) return handleImageFiles(blobs);
            toast('剪貼簿裡沒有圖片。請先截取地籍圖資網站左側的資料表（Win+Shift+S / Cmd+Ctrl+Shift+4），再按一次或直接 Ctrl+V', 'warn', 6500);
            return;
        } catch (e) {
            // 權限被拒或瀏覽器不支援讀取圖片 → 改用檔案選擇
        }
    }
    pickImageFile();
}

// ── 「匯入謄本」頁的截圖區塊 ──
function mountUploadZone(card) {
    injectStyles();
    if (!card || card.querySelector('#easymap-zone')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;color:#bbb;font-size:12px;margin:-4px 0 14px;">
            <div style="flex:1;height:1px;background:#eee;"></div>或<div style="flex:1;height:1px;background:#eee;"></div>
        </div>
        <div id="easymap-zone" class="em-zone" tabindex="0">
            <i class="fa-solid fa-map-location-dot"></i>
            <div style="font-size:14px;font-weight:700;color:#333;">地籍圖資截圖匯入</div>
            <div style="font-size:12px;color:#888;line-height:1.6;">
                截取「地籍圖資網路便民服務系統」左側的土地資料，<br>
                在這個頁面按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 貼上，或拖曳 / 點擊選擇圖片
            </div>
        </div>`;
    card.appendChild(wrap);

    const zone = wrap.querySelector('#easymap-zone');
    zone.addEventListener('click', pickImageFile);
    zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickImageFile(); } });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag');
        handleImageFiles(e.dataTransfer.files);
    });
}

// ── 全域 Ctrl+V ──
function onPaste(e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const items = Array.from(cd.items || []);
    const files = items.filter(it => it.kind === 'file' && /^image\//.test(it.type)).map(it => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    const t = e.target;
    const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const hasText = items.some(it => it.kind === 'string' && it.type === 'text/plain');
    if (editable && hasText) return; // 使用者是在輸入框貼文字
    e.preventDefault();
    handleImageFiles(files);
}

if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('paste', onPaste);
    if (document.head) injectStyles();
}

global.EasymapImport = {
    // UI
    handleImageFiles, importFromClipboard, mountUploadZone, pickImageFile, toast,
    // 純函式（方便測試）
    parseEasymapText, visionToLines, normalizeLandNo, normalizeOcrText,
    findLandKey, findLandKeyByText, makeLandKey, applyImport
};

})(typeof window !== 'undefined' ? window : globalThis);
