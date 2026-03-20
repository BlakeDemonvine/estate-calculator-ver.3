// --- 1. 資料與全域設定 ---
Chart.register(ChartDataLabels);

// ══════════════════════════════════════════════════════════════
// 土地增值稅自動計算模組
// ══════════════════════════════════════════════════════════════

const TAX_CPI_CACHE = { data: null, fetchedAt: null };

/**
 * 取得完整 CPI 資料（靜態表 + API 最新月份，帶 1 小時快取）
 *
 * 資料來源：
 *   - CPI_STATIC（cpi_static.js）：民國48年(1959)～民國114年(2025)，共 804 筆
 *     定義：ODS[月X] = (2026/2月 CPI) / (月X 的 CPI) × 100
 *   - 主計總處 API：民國70年(1981)起，定義為某固定基期 = 100 的絕對指數
 *
 * 橋接邏輯：
 *   bridge = CPI_STATIC["1981-M1"] / API["1981-M1"]
 *   → API[月X] × bridge = 換算成與 CPI_STATIC 同基期的值
 *   → 用此把 API 最新幾個月補入 CPI_STATIC（2026年以後靜態表沒有）
 *
 * 最終格式（統一基期：2026年2月 = 100）：
 *   { "1959-M1": 1124.8, ..., "1981-M1": 209.5, ..., "2026-M3": 99.x, ... }
 *
 * cpiRatio 計算方式：
 *   cpiRatio = result[prevKey] / result[currKey] × 100
 *   （prevKey = 前次移轉月份，currKey = 目前最新月份）
 */
async function fetchCPIData() {
    const now = Date.now();
    if (TAX_CPI_CACHE.data && TAX_CPI_CACHE.fetchedAt && (now - TAX_CPI_CACHE.fetchedAt) < 3600000) {
        return TAX_CPI_CACHE.data;
    }

    // 底層先填入靜態表（民國48~114年，含民國70年後的備用值）
    const result = Object.assign({}, CPI_STATIC);

    // 再呼叫 API 取得最新幾個月（2026年以後靜態表沒有）
    try {
        const url = 'https://nstatdb.dgbas.gov.tw/dgbasall/webMain.aspx?sdmx/A030101015/1...M.&startTime=1981&endTime=2030';
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`API ${resp.status}`);
        const json = await resp.json();
        const obsList = json.data.dataSets[0].series['0'].observations;
        const timeDim = json.data.structure.dimensions.observation[0].values;

        const apiRaw = {};
        for (const [idx, arr] of Object.entries(obsList)) {
            const key = timeDim[parseInt(idx)]?.id;
            if (key && arr[0] != null) apiRaw[key] = arr[0];
        }

        // 計算換算常數 K
        // 數學推導：CPI_STATIC[月X] * API[月X] = 常數 K（對任何月份成立）
        // 因為兩者都是同一個 CPI 值，只是基期不同，積等於 (2026-M2 / API基期) * 10000
        // 所以：CPI_STATIC["2026-M3"] = K / API["2026-M3"]
        const bridgeMonths = ['1981-M1','1981-M6','1982-M1','1983-M1','1984-M1','1985-M1'];
        let kSum = 0, kCount = 0;
        for (const k of bridgeMonths) {
            if (CPI_STATIC[k] && apiRaw[k]) {
                kSum += CPI_STATIC[k] * apiRaw[k];
                kCount++;
            }
        }
        if (kCount > 0) {
            const K = kSum / kCount;
            // 把 API 有但靜態表沒有的月份（2026年以後）補進來
            for (const [key, val] of Object.entries(apiRaw)) {
                const year = parseInt(key.split('-')[0]);
                if (year >= 2026 && val > 0) {
                    result[key] = parseFloat((K / val).toFixed(1));
                }
            }
        }
    } catch (e) {
        // API 失敗沒關係：靜態表已涵蓋到 2025/12
        // 如果當期月份超過 2026/2，cpiRatio 會略有誤差但仍可用
        console.warn('CPI API 失敗，使用靜態表', e);
    }

    TAX_CPI_CACHE.data = result;
    TAX_CPI_CACHE.fetchedAt = now;
    return result;
}

/**
 * 將「年/月」字串（民國 or 西元）解析成 API key，e.g. "2026-M3"
 * 支援格式：
 *   "115/3"、"115年3月"（民國，年份<1900）→ +1911
 *   "2026/3"、"2026-03"（西元，年份>=1900）→ 直接用
 */
function parseDateToApiKey(dateStr) {
    if (!dateStr) return null;
    let year, month;
    const rocMatch = dateStr.match(/^(\d{2,3})[\/年](\d{1,2})/);
    if (rocMatch) {
        year  = parseInt(rocMatch[1]);
        month = parseInt(rocMatch[2]);
        if (year < 1900) year += 1911;
    }
    if (!year) {
        const adMatch = dateStr.match(/(\d{4})[-\/](\d{1,2})/);
        if (adMatch) { year = parseInt(adMatch[1]); month = parseInt(adMatch[2]); }
    }
    if (!year || !month) return null;
    return `${year}-M${month}`; // API key 格式：不補零，e.g. "1981-M1" 而非 "1981-M01"
}

/** 取 CPI 資料中最新可用的 key（退至多 3 個月） */
function getLatestCpiKey(cpiData) {
    const now = new Date();
    for (let offset = 0; offset <= 6; offset++) {
        const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
        const key = `${d.getFullYear()}-M${d.getMonth() + 1}`;
        const val = cpiData[key];
        if (val != null && val > 0 && isFinite(val)) return key;
    }
    return null;
}

/**
 * 核心計算（財政部三級累進稅率，無持有年限減徵）
 * @param {number} currentValue    當期公告現值（元/m²）
 * @param {number} prevValue       前次公告現值（元/m²）
 * @param {number} totalArea       宗地面積（m²）
 * @param {number} scopeNum        移轉持分分子
 * @param {number} scopeDen        移轉持分分母
 * @param {number} cpiRatio        消費者物價總指數（%，e.g. 209.5）
 */
function calcTaxCore({ currentValue, prevValue, totalArea, scopeNum, scopeDen, cpiRatio }) {
    const ratio = scopeNum / scopeDen;

    // 申報現值總額（取公告現值）
    const declaredTotal = currentValue * totalArea * ratio;

    // 按物價指數調整後原規定地價或前次移轉現值總額 (b)
    const adjustedPrev = prevValue * totalArea * ratio * (cpiRatio / 100);

    // 漲價總數額 (a)
    const priceIncrease = declaredTotal - adjustedPrev;

    if (priceIncrease <= 0) {
        return { selfUseTax: 0, generalTax: 0, priceIncrease: 0, adjustedPrev, declaredTotal, cpiRatio, times: 0 };
    }

    // 漲價倍數
    const times = priceIncrease / adjustedPrev;

    // 自用住宅用地：一律 10%
    const selfUseTax = Math.max(0, Math.round(priceIncrease * 0.10));

    // 一般用地：三級累進（財政部標準，無持有年限減徵）
    // 第一級：times < 1 → 20%
    // 第二級：1 ≤ times < 2 → 30%，扣除 b×10%
    // 第三級：times ≥ 2 → 40%，扣除 b×30%
    let generalTax;
    if (times < 1) {
        generalTax = priceIncrease * 0.20;
    } else if (times < 2) {
        generalTax = priceIncrease * 0.30 - adjustedPrev * 0.10;
    } else {
        generalTax = priceIncrease * 0.40 - adjustedPrev * 0.30;
    }
    generalTax = Math.max(0, Math.round(generalTax));

    return { selfUseTax, generalTax, priceIncrease, adjustedPrev, declaredTotal, cpiRatio, times };
}

/**
 * 點擊「自動計算增值稅」按鈕時呼叫
 * @param {HTMLElement} btn  觸發的按鈕
 */
async function autoCalcTax(btn) {
    const card      = btn.closest('.owner-card');
    const statusEl  = card.querySelector('.tax-calc-status');
    const setStatus = (msg, color = '#888') => { statusEl.innerHTML = msg; statusEl.style.color = color; };

    // 讀取欄位
    const dateStr    = card.querySelector('.input-date').value.trim();
    const prevValue  = parseFloat(card.querySelector('.input-value').value) || 0;
    const scopeNum   = parseFloat(card.querySelector('.input-scope-num').value) || 1;
    const scopeDen   = parseFloat(card.querySelector('.input-scope-den').value) || 1;
    const currentValue = parseFloat(document.getElementById('editCurrentValue102').value) || 0;
    const totalArea    = parseFloat(document.getElementById('editTotalArea').value) || 0;

    // 手動覆蓋欄位（保留但不強制）
    const manualCpiEl  = card.querySelector('.input-manual-cpi');
    const manualCpiRaw = manualCpiEl ? parseFloat(manualCpiEl.value) : NaN;

    if (!dateStr)      return setStatus('⚠ 請填寫前次取得年月', '#e67e22');
    if (!prevValue)    return setStatus('⚠ 請填寫前次公告現值', '#e67e22');
    if (!currentValue) return setStatus('⚠ 請填寫當期公告現值', '#e67e22');
    if (!totalArea)    return setStatus('⚠ 請填寫土地總面積',   '#e67e22');

    btn.disabled = true;

    // 若使用者手動填了 CPI，優先採用（方便特殊情況覆蓋）
    if (!isNaN(manualCpiRaw) && manualCpiRaw > 0) {
        const result = calcTaxCore({ currentValue, prevValue, totalArea, scopeNum, scopeDen, cpiRatio: manualCpiRaw });
        card.querySelector('.input-tax-self').value      = result.selfUseTax;
        card.querySelector('.input-tax-gen').value       = result.generalTax;
        card.querySelector('.input-calc-tax-self').value = result.selfUseTax;
        card.querySelector('.input-calc-tax-gen').value  = result.generalTax;
        setStatus(`✅ 計算完成（手動CPI）｜物價總指數 ${manualCpiRaw.toFixed(2)}%｜漲價倍數 ${result.times.toFixed(2)}`, '#27ae60');
        btn.disabled = false;
        return;
    }

    setStatus('⏳ 查詢物價指數中...', '#7d2ae8');

    try {
        // fetchCPIData() 已自動合併靜態表(民國48~114)與 API 最新月份
        const cpiData = await fetchCPIData();

        const prevKey  = parseDateToApiKey(dateStr);
        const currKey  = getLatestCpiKey(cpiData);
        const prevYear = prevKey ? parseInt(prevKey.split('-')[0]) : 0;

        if (!prevKey) {
            setStatus(`⚠ 年月格式錯誤，請使用如：<b>69/8</b> 或 <b>115/3</b>`, '#e74c3c');
            btn.disabled = false;
            return;
        }
        if (cpiData[prevKey] == null) {
            const rocYear = prevYear - 1911;
            setStatus(
                `⚠ 找不到「${dateStr}」（${prevKey}）的 CPI 資料<br>` +
                `靜態表涵蓋民國48年～民國114年，請確認年月格式是否正確`,
                '#e74c3c'
            );
            btn.disabled = false;
            return;
        }
        if (!currKey) {
            setStatus('⚠ 無法取得當前月份 CPI', '#e74c3c');
            btn.disabled = false;
            return;
        }

        // cpiRatio = prevCPI / currCPI × 100
        // 因 CPI_STATIC 定義 = (2026/2月CPI) / (該月CPI) × 100
        // 所以：prevCPI/currCPI = cpiData[currKey] / cpiData[prevKey]  ← 注意分子分母
        // → cpiRatio = cpiData[prevKey] / cpiData[currKey] × 100
        const cpiRatio = (cpiData[prevKey] / cpiData[currKey]) * 100;

        const isBefore1981 = prevYear < 1981;
        const sourceNote   = isBefore1981 ? '（靜態表）' : '（API）';

        const result = calcTaxCore({ currentValue, prevValue, totalArea, scopeNum, scopeDen, cpiRatio });

        card.querySelector('.input-tax-self').value      = result.selfUseTax;
        card.querySelector('.input-tax-gen').value       = result.generalTax;
        card.querySelector('.input-calc-tax-self').value = result.selfUseTax;
        card.querySelector('.input-calc-tax-gen').value  = result.generalTax;

        setStatus(
            `✅ 計算完成${sourceNote}｜物價總指數 ${cpiRatio.toFixed(2)}%｜漲價倍數 ${result.times.toFixed(2)}｜` +
            `參考月份：${prevKey} → ${currKey}`,
            '#27ae60'
        );
    } catch (err) {
        setStatus(`❌ 錯誤：${err.message}`, '#e74c3c');
        console.error(err);
    } finally {
        btn.disabled = false;
    }
}

/**
 * 批次自動計算所有 owner-card 的增值稅（UI 模式，用於 modal 內的按鈕）
 */
async function autoCalcAllTax() {
    const cards = document.querySelectorAll('.owner-card');
    if (cards.length === 0) return alert('尚無所有權人資料');
    const btn = document.getElementById('btnCalcAllTax');
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 計算中...'; }
    for (const card of cards) {
        const singleBtn = card.querySelector('.btn-auto-calc-tax');
        if (singleBtn) await autoCalcTax(singleBtn);
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-calculator"></i> 全部自動計算增值稅'; }
}

/**
 * 謄本匯入後靜默批次計算：直接操作 data 物件
 * 民國48年以後全部自動計算（靜態表涵蓋民國48~114年，API 補最新月份）
 */
async function autoCalcAllTaxSilent() {
    let cpiData = null;
    try { cpiData = await fetchCPIData(); } catch(e) { console.warn('CPI 載入失敗，跳過自動計算', e); return; }

    const currKey = getLatestCpiKey(cpiData);
    if (!currKey) return;
    const currCpiOds = cpiData[currKey]; // 以 2026/2月基期的當期值

    for (const landId in data) {
        const record = data[landId];
        const owners  = record['所有權人'] || [];
        const area    = record['土地面積']?.['面積'] || 0;
        const currVal = record['當期公告現值'] || 0;

        for (let i = 0; i < owners.length; i++) {
            const dateStr  = (record['年月'] || [])[i] || '';
            const prevVal  = parseFloat((record['公告現值'] || [])[i]) || 0;
            const scopeArr = record['土地面積']?.['權利範圍'] || [];
            const scopeRaw = Array.isArray(scopeArr) ? scopeArr[i] : scopeArr;
            const scope    = parseFloat(scopeRaw) || 0;

            if (!dateStr || !prevVal || !currVal || !area || !scope) continue;

            const prevKey  = parseDateToApiKey(dateStr);
            const prevYear = prevKey ? parseInt(prevKey.split('-')[0]) : 0;

            // 靜態表涵蓋民國48年(1959)起，更早的才跳過
            if (!prevKey || prevYear < 1959 || cpiData[prevKey] == null) continue;

            // cpiRatio = prevCPI / currCPI × 100
            // 因兩者都是「2026/2月基期」格式：值越大代表當時物價越低（年代越久遠）
            // prevCPI/currCPI = cpiData[prevKey] / cpiData[currKey]
            const cpiRatio = (cpiData[prevKey] / currCpiOds) * 100;

            const scopeNums = record['土地面積']?.['權利範圍_num'];
            const scopeDens = record['土地面積']?.['權利範圍_den'];
            const sNum = (scopeNums && scopeNums[i]) ? scopeNums[i] : Math.round(scope * 1000);
            const sDen = (scopeDens && scopeDens[i]) ? scopeDens[i] : 1000;

            const result = calcTaxCore({ currentValue: currVal, prevValue: prevVal, totalArea: area, scopeNum: sNum, scopeDen: sDen, cpiRatio });

            if (!Array.isArray(record['增值稅預估(自用)'])) record['增值稅預估(自用)'] = new Array(owners.length).fill('');
            if (!Array.isArray(record['增值稅預估(一般)'])) record['增值稅預估(一般)'] = new Array(owners.length).fill('');
            if (!Array.isArray(record['增值稅試算(自用)']))  record['增值稅試算(自用)']  = new Array(owners.length).fill('');
            if (!Array.isArray(record['增值稅試算(一般)']))  record['增值稅試算(一般)']  = new Array(owners.length).fill('');

            record['增值稅預估(自用)'][i] = result.selfUseTax;
            record['增值稅預估(一般)'][i] = result.generalTax;
            record['增值稅試算(自用)'][i]  = result.selfUseTax;
            record['增值稅試算(一般)'][i]  = result.generalTax;
        }
    }

    refreshAllTaxBadges();
}

/**
 * 從「年/月」字串自動計算至今持有年限（僅供參考，不影響稅率）
 */
function autoCalcHoldingYears(dateStr) {
    if (!dateStr) return 0;
    const key = parseDateToApiKey(dateStr);
    if (!key) return 0;
    const [y, mPart] = key.split('-M');
    const year = parseInt(y), month = parseInt(mPart);
    const now = new Date();
    let years = now.getFullYear() - year;
    if (now.getMonth() + 1 < month) years--;
    return Math.max(0, years);
}



const charts = {}; 
const colorPalette = ['#FF9AA2', '#E27D9A', '#B0558F', '#7D3C98', '#4A2399', '#1D1E8F'];
const PING_FACTOR = 0.3025;

// --- 輔助函式：從建物門牌自動抓取樓層（支援國字與數字） ---
function extractFloorFromAddr(addr) {
    if (!addr) return '';
    const cnMap = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
                   '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,'十九':19,'二十':20,
                   '二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25,'三十':30,'四十':40,'五十':50};
    const m = addr.match(/([一二三四五六七八九十百千\d]+(?:之[一二三四五六七八九十\d]+)?)\s*樓/);
    if (!m) return '';
    const raw = m[1];
    // 若是純數字直接用
    if (/^\d+$/.test(raw)) return raw + '樓';
    // 否則查國字對照表
    if (cnMap[raw] !== undefined) return cnMap[raw] + '樓';
    // 嘗試解析「十X」、「X十Y」等組合
    let n = 0;
    let s = raw;
    const tens = s.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/);
    if (tens) {
        const t = tens[1] ? (cnMap[tens[1]] || 0) : 1;
        const u = tens[2] ? (cnMap[tens[2]] || 0) : 0;
        n = t * 10 + u;
    }
    return n > 0 ? n + '樓' : raw + '樓';
}

let currentEditingId = null;

let content = document.getElementById('canvas-area');

// --- 輔助函式：求最大公因數 ---
function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { let temp = b; b = a % b; a = temp; }
    return a;
}

// --- 輔助函式：將小數轉換為最簡分數 ---
function decimalToFraction(decimal) {
    if (!decimal || decimal === 0) return { num: 0, den: 1 };
    if (decimal === 1) return { num: 1, den: 1 };
    let precision = 1000000;
    let num = Math.round(decimal * precision);
    let den = precision;
    let commonDivisor = gcd(num, den);
    return { num: num / commonDivisor, den: den / commonDivisor };
}

// --- 2. 初始化 ---
document.addEventListener("DOMContentLoaded", function() {
    const targetIds = ['A', 'B', 'C', 'D', 'E', 'F'];
    const items = targetIds.map(id => document.getElementById(id)).filter(item => item !== null);
    items.forEach(item => {
        item.addEventListener('click', function() {
            items.forEach(el => el.classList.remove('active'));
            this.classList.add('active');
            show(this.id);
        });
    });
    if (Object.keys(data).length > 0) {
        document.getElementById('A').classList.remove('active');
        document.getElementById('B').classList.add('active');
        show('B'); 
    } else {
        show('A'); 
    }
});

// --- 3. 頁面切換邏輯 ---
function show(input){
    content.innerHTML = '';
    content.className = 'canvas-area'; 
    document.getElementById('globalSummary').classList.add('hidden-bar');
    
    Object.keys(charts).forEach(id => {
        if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    });

    const landSegment = basics['地段'] || '未命名專案';
    document.getElementById('title').value = landSegment;
    document.title = landSegment + " - 磚家計算";

    // ══════════════════════════════════════════════════════════════
    // Section A：匯入謄本（Google Vision OCR）
    // ══════════════════════════════════════════════════════════════
    if(input === 'A'){
        content.style.cssText = 'display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:40px 20px; gap:0;';

        if (!document.getElementById('ocr-keyframes')) {
            const st = document.createElement('style');
            st.id = 'ocr-keyframes';
            st.textContent = `@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.2}}`;
            document.head.appendChild(st);
        }

        const savedKey = localStorage.getItem('gv_api_key') || '';

        const card = document.createElement('div');
        card.id = 'ocr-upload-card';
        card.style.cssText = 'background:white; border-radius:20px; box-shadow:0 8px 40px rgba(125,42,232,0.08); border:1px solid #f0eaff; padding:36px 40px; width:100%; max-width:480px; display:flex; flex-direction:column; gap:20px;';

        card.innerHTML = `
          <div style="text-align:center; padding-bottom:4px;">
            <div style="width:56px; height:56px; background:linear-gradient(135deg,#00c4cc22,#7d2ae822); border-radius:16px; display:flex; align-items:center; justify-content:center; margin:0 auto 16px;">
              <i class="fa-solid fa-file-pdf" style="font-size:26px; background:var(--header-bg); -webkit-background-clip:text; -webkit-text-fill-color:transparent;"></i>
            </div>
            <div style="font-size:20px; font-weight:700; color:#1a1a2e; letter-spacing:-0.3px;">匯入謄本</div>
          </div>

          <div>
            <div style="font-size:12px; font-weight:600; color:#aaa; letter-spacing:0.5px; text-transform:uppercase; margin-bottom:8px;">API Key</div>
            <div style="display:flex; gap:8px;">
              <input type="password" id="gv-key-input" value="${savedKey}" placeholder="AIzaSy..."
                style="flex:1; padding:11px 14px; border:1.5px solid #ede8ff; border-radius:10px; font-size:14px; font-family:monospace; outline:none; transition:all 0.2s; background:#fdfcff; color:#333;"
                onfocus="this.style.borderColor='var(--accent-purple)'; this.style.boxShadow='0 0 0 3px rgba(125,42,232,0.08)'"
                onblur="this.style.borderColor='#ede8ff'; this.style.boxShadow='none'">
              <button id="gv-key-toggle"
                style="width:42px; border:1.5px solid #ede8ff; border-radius:10px; background:#fdfcff; cursor:pointer; color:#aaa; transition:0.2s; flex-shrink:0;"
                onmouseover="this.style.borderColor='var(--accent-purple)'; this.style.color='var(--accent-purple)'"
                onmouseout="this.style.borderColor='#ede8ff'; this.style.color='#aaa'">
                <i class="fa-solid fa-eye"></i>
              </button>
            </div>
          </div>

          <div id="drop-zone-a"
            style="border:2px dashed #e8e0ff; border-radius:14px; padding:36px 20px; text-align:center; cursor:pointer; transition:all 0.25s; background:#fdfcff; display:flex; flex-direction:column; align-items:center; gap:10px;">
            <i class="fa-solid fa-arrow-up-from-bracket" style="font-size:28px; color:#c4b5fd; transition:all 0.25s;"></i>
            <div style="font-size:14px; color:#888;">拖曳或點擊選擇 PDF</div>
          </div>

          <input type="file" id="ocr-file-input" multiple accept="application/pdf" style="display:none;">

          <button id="ocr-select-btn"
            style="width:100%; padding:13px; background:var(--header-bg); color:white; border:none; border-radius:10px; font-size:15px; font-weight:600; cursor:pointer; transition:all 0.2s; box-shadow:0 4px 16px rgba(125,42,232,0.2); display:flex; justify-content:center; align-items:center; gap:8px; letter-spacing:0.2px;"
            onmouseover="this.style.opacity='0.9'; this.style.transform='translateY(-1px)'; this.style.boxShadow='0 6px 20px rgba(125,42,232,0.3)'"
            onmouseout="this.style.opacity='1'; this.style.transform='none'; this.style.boxShadow='0 4px 16px rgba(125,42,232,0.2)'">
            <i class="fa-solid fa-folder-open"></i> 選擇檔案
          </button>
        `;

        content.appendChild(card);

        document.getElementById('gv-key-toggle').addEventListener('click', () => {
            const inp = document.getElementById('gv-key-input');
            inp.type = inp.type === 'password' ? 'text' : 'password';
        });

        const dz = document.getElementById('drop-zone-a');
        dz.addEventListener('dragover', e => {
            e.preventDefault();
            dz.style.borderColor = 'var(--accent-purple)';
            dz.style.background = 'rgba(125,42,232,0.04)';
            dz.querySelector('i').style.color = 'var(--accent-purple)';
        });
        dz.addEventListener('dragleave', () => {
            dz.style.borderColor = '#e8e0ff';
            dz.style.background = '#fdfcff';
            dz.querySelector('i').style.color = '#c4b5fd';
        });
        dz.addEventListener('drop', e => {
            e.preventDefault();
            dz.style.borderColor = '#e8e0ff';
            dz.style.background = '#fdfcff';
            dz.querySelector('i').style.color = '#c4b5fd';
            const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
            if (files.length) triggerOcr(files);
        });
        dz.addEventListener('click', () => document.getElementById('ocr-file-input').click());
        document.getElementById('ocr-select-btn').addEventListener('click', () => document.getElementById('ocr-file-input').click());

        document.getElementById('ocr-file-input').addEventListener('change', e => {
            const files = Array.from(e.target.files);
            if (files.length) triggerOcr(files);
        });

        function triggerOcr(files) {
            const apiKey = (document.getElementById('gv-key-input').value || '').trim();
            if (!apiKey) { alert('請先輸入 API Key'); return; }
            localStorage.setItem('gv_api_key', apiKey);
            startOcrImport(files, apiKey);
        }
    }

    // ══════════════════════════════════════════════════════════════
    // Section B：地號圖表
    // ══════════════════════════════════════════════════════════════
    else if(input === 'B'){
        content.style.display = ''; 
        let searchContainer = document.createElement('div');
        searchContainer.style.cssText = 'padding: 20px 40px 0 40px; display: flex; justify-content: center;';
        searchContainer.innerHTML = `
            <div style="position: relative; width: 100%; max-width: 400px;">
                <i class="fa-solid fa-magnifying-glass" style="position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: #888;"></i>
                <input type="text" id="searchB" placeholder="搜尋地號..." 
                    style="width: 100%; padding: 12px 12px 12px 40px; border-radius: 50px; border: 1px solid #ccc; font-size: 16px; outline: none;">
            </div>
        `;
        content.appendChild(searchContainer);
        
        let gridContainer = document.createElement('div');
        gridContainer.classList.add('chart-grid-container');
        gridContainer.id = 'gridB';
        content.appendChild(gridContainer);

        document.getElementById('searchB').addEventListener('input', function(e) {
            const val = e.target.value.toLowerCase();
            gridContainer.querySelectorAll('.chart-card').forEach(card => {
                card.style.display = card.querySelector('.chart-title').innerText.toLowerCase().includes(val) ? 'flex' : 'none';
            });
        });

        for(let num in data){
            let cardHTML = createChartBlock(`chart_${num}`, `地號：${num}`);
            gridContainer.insertAdjacentHTML('beforeend', cardHTML);
            initChart(`chart_${num}`);
            const owners = data[num]['所有權人'];
            if(owners && Array.isArray(owners)){
                for(let i = 0; i < owners.length; i++){
                    let areaVal = data[num]['土地面積']['面積'];
                    let scopes = data[num]['土地面積']['權利範圍'];
                    let scopeVal = Array.isArray(scopes) ? scopes[i] : scopes;
                    addPerson(`chart_${num}`, owners[i], areaVal * scopeVal);
                }
            }
        }
        updateGlobalSummary();
        document.getElementById('globalSummary').classList.remove('hidden-bar');
        setTimeout(captureThumbnail, 1200);
    }
    else if(input === 'C'){
        content.style.display = '';
        let searchContainer = document.createElement('div');
        searchContainer.style.cssText = 'padding: 20px 40px 0 40px; display: flex; justify-content: center;';
        searchContainer.innerHTML = `
             <div style="position: relative; width: 100%; max-width: 400px;">
                <i class="fa-solid fa-user" style="position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: #888;"></i>
                <input type="text" id="searchC" placeholder="搜尋所有權人..." 
                    style="width: 100%; padding: 12px 12px 12px 40px; border-radius: 50px; border: 1px solid #ccc; font-size: 16px; outline: none;">
            </div>
        `;
        content.appendChild(searchContainer);

        let gridContainer = document.createElement('div');
        gridContainer.classList.add('chart-grid-container');
        gridContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(500px, 1fr))';
        content.appendChild(gridContainer);
        document.getElementById('globalSummary').classList.add('hidden-bar');

        let personData = {}; 
        for (let landId in data) {
            let record = data[landId];
            let owners = record['所有權人'] || [];
            for (let i = 0; i < owners.length; i++) {
                let name = owners[i];
                if (!personData[name]) {
                    personData[name] = { name: name, lands: [], totalAreaM2: 0, totalPing: 0, totalTaxSelf: 0, totalTaxGen: 0 };
                }
                let area = record['土地面積']['面積'] || 0;
                let scope = Array.isArray(record['土地面積']['權利範圍']) ? record['土地面積']['權利範圍'][i] : record['土地面積']['權利範圍'];
                let heldM2 = area * scope;
                let heldPing = heldM2 * PING_FACTOR;
                let taxSelf = parseFloat(Array.isArray(record['增值稅預估(自用)']) ? record['增值稅預估(自用)'][i] : record['增值稅預估(自用)']) || 0;
                let taxGen = parseFloat(Array.isArray(record['增值稅預估(一般)']) ? record['增值稅預估(一般)'][i] : record['增值稅預估(一般)']) || 0;
                personData[name].lands.push({
                    id: landId, scope: scope, heldPing: heldPing,
                    date: Array.isArray(record['年月']) ? record['年月'][i] : record['年月'],
                    prevVal: Array.isArray(record['公告現值']) ? record['公告現值'][i] : record['公告現值'],
                    currVal: record['當期公告現值'] || 0,
                    taxSelf: taxSelf, taxGen: taxGen
                });
                personData[name].totalAreaM2 += heldM2;
                personData[name].totalPing += heldPing;
                personData[name].totalTaxSelf += taxSelf;
                personData[name].totalTaxGen += taxGen;
            }
        }

        Object.values(personData).forEach(person => {
            let card = document.createElement('div');
            card.className = 'chart-card';
            card.style.alignItems = 'stretch';
            card.style.height = 'auto';
            let header = `<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #f0f0f0;padding-bottom:15px;margin-bottom:15px;"><h3 style="font-size:22px;font-weight:700;color:#333;margin:0;">${person.name}</h3><span style="background:var(--accent-purple);color:white;padding:4px 12px;border-radius:15px;font-size:12px;">持有 ${person.lands.length} 筆</span></div>`;
            let rowsHTML = person.lands.map(land => `<tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#0056b3;">${land.id}</td><td style="padding:10px;text-align:center;">${(land.scope).toFixed(4)}</td><td style="padding:10px;text-align:right;">${land.heldPing.toFixed(2)}</td><td style="padding:10px;text-align:right;color:#888;">${parseFloat(land.currVal).toLocaleString()}</td><td style="padding:10px;text-align:right;color:#d93025;">${Math.round(land.taxSelf).toLocaleString()}</td><td style="padding:10px;text-align:right;">${Math.round(land.taxGen).toLocaleString()}</td></tr>`).join('');
            let table = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="background:#f9f9f9;color:#666;"><th style="padding:8px;text-align:left;">地號</th><th style="padding:8px;text-align:center;">權利範圍</th><th style="padding:8px;text-align:right;">持分(坪)</th><th style="padding:8px;text-align:right;">當期現值</th><th style="padding:8px;text-align:right;">增值稅(自)</th><th style="padding:8px;text-align:right;">增值稅(般)</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>`;
            let footer = `<div style="margin-top:20px;background:#f0f7ff;padding:15px;border-radius:8px;display:flex;justify-content:space-around;align-items:center;"><div style="text-align:center;"><div style="font-size:12px;color:#666;">總持分坪數</div><div style="font-size:18px;font-weight:bold;color:#333;">${person.totalPing.toFixed(2)}</div></div><div style="width:1px;height:30px;background:#ddd;"></div><div style="text-align:center;"><div style="font-size:12px;color:#666;">增值稅合計(自)</div><div style="font-size:18px;font-weight:bold;color:#d93025;">$${Math.round(person.totalTaxSelf).toLocaleString()}</div></div><div style="width:1px;height:30px;background:#ddd;"></div><div style="text-align:center;"><div style="font-size:12px;color:#666;">增值稅合計(般)</div><div style="font-size:18px;font-weight:bold;color:#333;">$${Math.round(person.totalTaxGen).toLocaleString()}</div></div></div>`;
            card.innerHTML = header + table + footer;
            gridContainer.appendChild(card);
        });

        document.getElementById('searchC').addEventListener('input', function(e) {
            const val = e.target.value.toLowerCase();
            gridContainer.querySelectorAll('.chart-card').forEach(card => {
                card.style.display = card.querySelector('h3').innerText.toLowerCase().includes(val) ? 'flex' : 'none';
            });
        });
    }
    else if(input === 'D'){
        content.style.display = '';
        document.getElementById('globalSummary').classList.add('hidden-bar');

        // 確保 basics['土地歸戶表'] 有新的參數欄位
        const tbl = basics['土地歸戶表'] || {};
        if (!tbl['合計法定容積']) tbl['合計法定容積'] = 2.25;
        if (!tbl['地主法定容積佔比']) tbl['地主法定容積佔比'] = 0.58;
        if (!tbl['都更獎勵容積']) tbl['都更獎勵容積'] = 0.5;
        if (!tbl['地主獎勵容積佔比']) tbl['地主獎勵容積佔比'] = 0.5;
        if (!tbl['防災都更獎勵容積']) tbl['防災都更獎勵容積'] = 0.3;
        if (!tbl['地主防災都更佔比']) tbl['地主防災都更佔比'] = 0.5;
        if (!tbl['合建分取']) tbl['合建分取'] = 1.58;
        basics['土地歸戶表'] = tbl;

        const inputStyle = 'width:72px;padding:7px 10px;border:1.5px solid #e0d5f7;border-radius:8px;font-size:13px;font-weight:600;color:#333;text-align:center;outline:none;';
        const labelStyle = 'font-size:12px;font-weight:700;color:var(--accent-purple);white-space:nowrap;';

        let controlPanel = document.createElement('div');
        controlPanel.style.cssText = 'background:white;padding:16px 24px;border-radius:14px;margin:16px 36px 0;box-shadow:0 4px 18px rgba(0,0,0,0.06);display:flex;flex-wrap:wrap;gap:16px;align-items:center;';
        controlPanel.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="${labelStyle}">合計法定容積：</span>
                <input type="number" id="dParam_legalFar" value="${tbl['合計法定容積']}" step="0.01" style="${inputStyle}">
                <span style="color:#aaa;font-size:13px;">×</span>
                <span style="${labelStyle}">地主法定佔比：</span>
                <input type="number" id="dParam_legalOwnerRatio" value="${tbl['地主法定容積佔比']}" step="0.01" style="${inputStyle}">
            </div>
            <div style="width:1px;height:30px;background:#eee;"></div>
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="${labelStyle}">都更獎勵容積：</span>
                <input type="number" id="dParam_bonusFar" value="${tbl['都更獎勵容積']}" step="0.01" style="${inputStyle}">
                <span style="color:#aaa;font-size:13px;">×</span>
                <span style="${labelStyle}">地主獎勵佔比：</span>
                <input type="number" id="dParam_bonusOwnerRatio" value="${tbl['地主獎勵容積佔比']}" step="0.01" style="${inputStyle}">
            </div>
            <div style="width:1px;height:30px;background:#eee;"></div>
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="${labelStyle}">防災都更獎勵：</span>
                <input type="number" id="dParam_disasterFar" value="${tbl['防災都更獎勵容積']}" step="0.01" style="${inputStyle}">
                <span style="color:#aaa;font-size:13px;">×</span>
                <span style="${labelStyle}">防災地主佔比：</span>
                <input type="number" id="dParam_disasterOwnerRatio" value="${tbl['地主防災都更佔比']}" step="0.01" style="${inputStyle}">
            </div>
            <div style="width:1px;height:30px;background:#eee;"></div>
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="${labelStyle}">免計容積係數：</span>
                <input type="number" id="dParam_jointRatio" value="${tbl['合建分取']}" step="0.01" style="${inputStyle}">
            </div>
        `;
        content.appendChild(controlPanel);

        let gridContainer = document.createElement('div');
        gridContainer.classList.add('chart-grid-container');
        gridContainer.id = 'gridD';
        gridContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(340px, 1fr))';
        content.appendChild(gridContainer);

        function renderCards() {
            gridContainer.innerHTML = '';
            const legalFar   = parseFloat(document.getElementById('dParam_legalFar').value) || 0;
            const legalOR    = parseFloat(document.getElementById('dParam_legalOwnerRatio').value) || 0;
            const bonusFar   = parseFloat(document.getElementById('dParam_bonusFar').value) || 0;
            const bonusOR    = parseFloat(document.getElementById('dParam_bonusOwnerRatio').value) || 0;
            const disastFar  = parseFloat(document.getElementById('dParam_disasterFar').value) || 0;
            const disastOR   = parseFloat(document.getElementById('dParam_disasterOwnerRatio').value) || 0;
            const jRatio     = parseFloat(document.getElementById('dParam_jointRatio').value) || 0;

            basics['土地歸戶表']['合計法定容積'] = legalFar;
            basics['土地歸戶表']['地主法定容積佔比'] = legalOR;
            basics['土地歸戶表']['都更獎勵容積'] = bonusFar;
            basics['土地歸戶表']['地主獎勵容積佔比'] = bonusOR;
            basics['土地歸戶表']['防災都更獎勵容積'] = disastFar;
            basics['土地歸戶表']['地主防災都更佔比'] = disastOR;
            basics['土地歸戶表']['合建分取'] = jRatio;
            if (typeof window.saveProjectToLocal === 'function') window.saveProjectToLocal();

            let personData = {};
            for (let landId in data) {
                let record = data[landId];
                let owners = record['所有權人'] || [];
                for (let i = 0; i < owners.length; i++) {
                    let name = owners[i];
                    if (!personData[name]) personData[name] = { name: name, totalHeldPing: 0 };
                    let scope = Array.isArray(record['土地面積']['權利範圍']) ? record['土地面積']['權利範圍'][i] : record['土地面積']['權利範圍'];
                    personData[name].totalHeldPing += (record['土地面積']['面積'] || 0) * scope * PING_FACTOR;
                }
            }

            Object.values(personData).forEach(person => {
                const G = person.totalHeldPing; // 總持分坪
                // 法定容積
                const totalLegalFar   = G * legalFar;                // 合計法定容積
                const ownerLegalFar   = G * legalFar * legalOR;      // 地主獲得的法定容積
                // 都更獎勵
                const totalBonusFar   = G * legalFar * bonusFar;     // 合計獲得的都更獎勵容積
                const ownerBonusFar   = G * legalFar * bonusFar * bonusOR; // 地主獲得的都更獎勵
                // 防災都更
                const totalDisastFar  = G * legalFar * disastFar;    // 合計獲得的防災獎勵
                const ownerDisastFar  = totalDisastFar * disastOR;   // 地主獲得的防災獎勵
                // 合建分取
                const withDisast  = (ownerLegalFar + ownerBonusFar + ownerDisastFar) * jRatio;
                const withoutDisast = (ownerLegalFar + ownerBonusFar) * jRatio;

                let card = document.createElement('div');
                card.className = 'chart-card';
                card.style.height = 'auto';
                card.style.background = 'linear-gradient(to bottom right, #ffffff, #fdfbff)';
                card.innerHTML = `
                    <h3 style="width:100%;border-bottom:1px solid #eee;padding-bottom:10px;margin-bottom:15px;color:#333;font-size:16px;">${person.name}</h3>
                    <div style="width:100%;display:flex;flex-direction:column;gap:10px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;background:#f8f7ff;padding:10px;border-radius:8px;border:1px solid #ede8ff;">
                            <span style="font-size:12px;color:#666;">總持分面積 (坪)</span>
                            <span style="font-size:18px;font-weight:700;color:var(--accent-purple);">${G.toFixed(3)}</span>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                            <div style="background:#e8f5e9;padding:9px;border-radius:7px;border:1px solid #c8e6c9;">
                                <div style="font-size:10px;color:#2e7d32;font-weight:700;margin-bottom:3px;">合計法定容積</div>
                                <div style="font-size:15px;font-weight:700;color:#1b5e20;">${totalLegalFar.toFixed(3)}</div>
                            </div>
                            <div style="background:#e8f5e9;padding:9px;border-radius:7px;border:1px solid #c8e6c9;">
                                <div style="font-size:10px;color:#2e7d32;font-weight:700;margin-bottom:3px;">地主獲得法定容積</div>
                                <div style="font-size:15px;font-weight:700;color:#1b5e20;">${ownerLegalFar.toFixed(3)}</div>
                            </div>
                            <div style="background:#e3f2fd;padding:9px;border-radius:7px;border:1px solid #bbdefb;">
                                <div style="font-size:10px;color:#1565c0;font-weight:700;margin-bottom:3px;">合計都更獎勵容積</div>
                                <div style="font-size:15px;font-weight:700;color:#0d47a1;">${totalBonusFar.toFixed(3)}</div>
                            </div>
                            <div style="background:#e3f2fd;padding:9px;border-radius:7px;border:1px solid #bbdefb;">
                                <div style="font-size:10px;color:#1565c0;font-weight:700;margin-bottom:3px;">地主獲得都更獎勵</div>
                                <div style="font-size:15px;font-weight:700;color:#0d47a1;">${ownerBonusFar.toFixed(3)}</div>
                            </div>
                            <div style="background:#fce4ec;padding:9px;border-radius:7px;border:1px solid #f8bbd0;">
                                <div style="font-size:10px;color:#880e4f;font-weight:700;margin-bottom:3px;">合計防災都更獎勵</div>
                                <div style="font-size:15px;font-weight:700;color:#880e4f;">${totalDisastFar.toFixed(3)}</div>
                            </div>
                            <div style="background:#fce4ec;padding:9px;border-radius:7px;border:1px solid #f8bbd0;">
                                <div style="font-size:10px;color:#880e4f;font-weight:700;margin-bottom:3px;">地主獲得防災獎勵</div>
                                <div style="font-size:15px;font-weight:700;color:#880e4f;">${ownerDisastFar.toFixed(3)}</div>
                            </div>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                            <div style="background:linear-gradient(135deg,#fff8e8,#ffefc7);padding:12px;border-radius:8px;border:1px solid #ffd97a;">
                                <div style="font-size:10px;color:#c47d00;font-weight:700;margin-bottom:4px;">有防災都更合建分取 (坪)</div>
                                <div style="font-size:19px;font-weight:800;color:#e65100;">${withDisast.toFixed(3)}</div>
                            </div>
                            <div style="background:linear-gradient(135deg,#fff3e0,#ffe0b2);padding:12px;border-radius:8px;border:1px solid #ffcc80;">
                                <div style="font-size:10px;color:#bf360c;font-weight:700;margin-bottom:4px;">無防災都更合建分取 (坪)</div>
                                <div style="font-size:19px;font-weight:800;color:#bf360c;">${withoutDisast.toFixed(3)}</div>
                            </div>
                        </div>
                    </div>`;
                gridContainer.appendChild(card);
            });
        }

        ['dParam_legalFar','dParam_legalOwnerRatio','dParam_bonusFar','dParam_bonusOwnerRatio',
         'dParam_disasterFar','dParam_disasterOwnerRatio','dParam_jointRatio'].forEach(id => {
            document.getElementById(id).addEventListener('input', renderCards);
        });
        renderCards();
    }

    else if(input === 'E'){
        content.style.display = '';
        document.getElementById('globalSummary').classList.add('hidden-bar');

        // ── inject E-page styles (site theme: white bg, purple accent) ──
        if (!document.getElementById('e-page-styles')) {
            const st = document.createElement('style');
            st.id = 'e-page-styles';
            st.textContent = `
                #e-page { font-family:'Segoe UI',system-ui,sans-serif; }
                #e-page .e-ctrl-panel {
                    background:white; border-radius:14px; margin:20px 36px 0;
                    box-shadow:0 4px 18px rgba(0,0,0,0.06);
                    padding:16px 24px; display:flex; flex-wrap:wrap; gap:16px; align-items:center;
                }
                #e-page .e-ctrl-group { display:flex; align-items:center; gap:8px; }
                #e-page .e-ctrl-label { font-size:12px; font-weight:700; color:var(--accent-purple); white-space:nowrap; }
                #e-page .e-ctrl-input {
                    width:72px; padding:7px 10px; border:1.5px solid #e0d5f7; border-radius:8px;
                    font-size:13px; font-weight:600; color:#333; text-align:center; outline:none; transition:0.2s;
                }
                #e-page .e-ctrl-input:focus { border-color:var(--accent-purple); box-shadow:0 0 0 3px rgba(125,42,232,0.1); }
                #e-page .e-ctrl-sep { color:#ccc; font-size:14px; font-weight:700; }
                #e-page .e-summary-bar {
                    display:flex; flex-wrap:wrap; gap:0;
                    background:white; border-radius:14px; margin:14px 36px 0;
                    box-shadow:0 4px 18px rgba(0,0,0,0.06); overflow:hidden;
                }
                #e-page .e-sum-item { flex:1; min-width:120px; padding:14px 20px; border-right:1px solid #f0f0f0; }
                #e-page .e-sum-item:last-child { border-right:none; }
                #e-page .e-sum-label { font-size:10px; color:#999; font-weight:700; letter-spacing:1px; text-transform:uppercase; margin-bottom:4px; }
                #e-page .e-sum-value { font-size:22px; font-weight:800; color:#1a1a2e; }
                #e-page .e-sum-unit { font-size:12px; color:#aaa; margin-left:2px; }
                #e-page .e-sum-item.accent .e-sum-value { background:var(--header-bg); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
                #e-page .e-grid {
                    display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr));
                    gap:20px; padding:20px 36px 40px;
                }
                /* card */
                #e-page .e-card {
                    background:white; border-radius:20px;
                    box-shadow:0 8px 28px rgba(0,0,0,0.07);
                    border:1px solid rgba(0,0,0,0.04);
                    padding:22px; display:flex; flex-direction:column; gap:0;
                    transition:transform 0.25s, box-shadow 0.25s;
                    animation: eFadeUp 0.4s ease both;
                }
                #e-page .e-card:hover { transform:translateY(-4px); box-shadow:0 16px 40px rgba(125,42,232,0.12); }
                #e-page .e-card-header { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
                #e-page .e-card-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; }
                #e-page .e-card-name { font-size:16px; font-weight:800; color:#1a1a2e; }
                #e-page .e-card-badge {
                    font-size:10px; padding:2px 10px; border-radius:20px; font-weight:700;
                    background:#f4efff; color:var(--accent-purple); margin-left:auto;
                }
                #e-page .e-card-addr { font-size:11px; color:#aaa; margin-bottom:14px; padding-left:20px; }
                /* 3D building */
                #e-page .e-building-wrap { width:100%; height:116px; margin-bottom:16px; }
                #e-page .e-building-wrap svg { width:100%; height:100%; overflow:visible; }
                /* stat grid */
                #e-page .e-stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
                #e-page .e-stat { background:#f8f7ff; border-radius:10px; padding:10px 13px; border:1px solid #ede8ff; }
                #e-page .e-stat.purple { background:linear-gradient(135deg,#f4efff,#ede0ff); border-color:#d0b8f8; }
                #e-page .e-stat.teal   { background:linear-gradient(135deg,#e6fafa,#ccf2f2); border-color:#99e0e0; }
                #e-page .e-stat.amber  { background:linear-gradient(135deg,#fff8e8,#ffefc7); border-color:#ffd97a; }
                #e-page .e-stat.green  { background:linear-gradient(135deg,#e8f8f1,#cceed e); border-color:#88d9b4; }
                #e-page .e-stat.rose   { background:linear-gradient(135deg,#fff0f0,#ffd6d6); border-color:#ffaaaa; }
                #e-page .e-stat-label { font-size:10px; color:#999; font-weight:700; letter-spacing:0.8px; text-transform:uppercase; margin-bottom:3px; }
                #e-page .e-stat-value { font-size:18px; font-weight:800; color:#1a1a2e; font-variant-numeric:tabular-nums; }
                #e-page .e-stat-unit  { font-size:10px; color:#aaa; margin-left:2px; }
                #e-page .e-stat.purple .e-stat-value { color:var(--accent-purple); }
                #e-page .e-stat.teal   .e-stat-value { color:#00a8ad; }
                #e-page .e-stat.amber  .e-stat-value { color:#c47d00; }
                #e-page .e-stat.green  .e-stat-value { color:#1a8a5a; }
                #e-page .e-stat.rose   .e-stat-value { color:#cc3333; }
                /* bar rows */
                #e-page .e-bars { display:flex; flex-direction:column; gap:7px; margin-bottom:14px; }
                #e-page .e-bar-row { display:flex; align-items:center; gap:8px; }
                #e-page .e-bar-lbl { font-size:11px; color:#aaa; width:64px; text-align:right; flex-shrink:0; }
                #e-page .e-bar-track { flex:1; height:7px; background:#f0eeff; border-radius:4px; overflow:hidden; }
                #e-page .e-bar-fill { height:100%; border-radius:4px; transition:width 0.7s cubic-bezier(.25,.46,.45,.94); }
                #e-page .e-bar-val { font-size:11px; color:#888; width:48px; text-align:right; font-variant-numeric:tabular-nums; }
                /* divider */
                #e-page .e-divider { border:none; border-top:1px solid #f0f0f0; margin:10px 0; }
                /* diff pill */
                #e-page .e-diff-pill { display:inline-flex; align-items:center; gap:5px; padding:5px 12px; border-radius:20px; font-size:12px; font-weight:700; }
                #e-page .e-diff-pill.pos { background:#e8f8f1; color:#1a8a5a; }
                #e-page .e-diff-pill.neg { background:#fff0f0; color:#cc3333; }
                #e-page .e-diff-pill.zero { background:#f5f5f5; color:#aaa; }
                #e-page .e-orig-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; }
                #e-page .e-orig-item { background:#fafafa; border-radius:8px; padding:8px 10px; border:1px solid #f0f0f0; }
                #e-page .e-orig-label { font-size:9px; color:#bbb; font-weight:700; letter-spacing:0.5px; text-transform:uppercase; }
                #e-page .e-orig-value { font-size:13px; font-weight:800; color:#555; }
                @keyframes eFadeUp { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
                @keyframes eRise { from { transform:scaleY(0); opacity:0; } to { transform:scaleY(1); opacity:1; } }
            `;
            document.head.appendChild(st);
        }

        const wrapper = document.createElement('div');
        wrapper.id = 'e-page';
        content.appendChild(wrapper);

        const ACCENT_COLORS = [
            '#7d2ae8','#00c4cc','#f59e0b','#10b981','#f43f5e','#3b82f6','#8b5cf6','#ec4899'
        ];

        // ── 3D building SVG (site-themed: purple+teal gradient) ──
        function buildingSVG3D(totalPing, allocPing, accentColor, myFloor, maxFloor) {
            const W = 290, H = 116;
            const maxF = Math.max(maxFloor || myFloor, 2);
            const fh = Math.min(13, Math.max(6, Math.floor((H - 28) / maxF)));
            const bw = 60, depth = 16;
            const baseX = (W - bw - depth) / 2, baseY = H - 14;

            let floorsSVG = '';
            for (let f = 0; f < maxF; f++) {
                const fy = baseY - f * (fh + 1.5);
                const lit = f < myFloor;  // floors this owner actually owns
                const delay = (f * 0.04).toFixed(2);
                const fc    = lit ? accentColor : accentColor + 'aa';
                const topC  = lit ? accentColor + '66' : accentColor + '88';
                const sideC = lit ? accentColor + '44' : accentColor + '66';
                const strokeC = lit ? accentColor : accentColor + 'aa';
                const winC  = lit ? '#fff' : accentColor + 'cc';
                const winOp = lit ? '0.85' : '0.55';
                const faceOp = lit ? '0.85' : '0.45';
                floorsSVG += `<g style="animation:eRise ${0.25 + f*0.04}s ease ${delay}s both;transform-origin:${baseX}px ${baseY}px">
                    <rect x="${baseX}" y="${fy-fh}" width="${bw}" height="${fh}" fill="${fc}" opacity="${faceOp}" stroke="${strokeC}" stroke-width="0.6"/>
                    ${[0,1,2].map(w=>`<rect x="${baseX+5+w*18}" y="${fy-fh+2}" width="10" height="${fh-4}" rx="1.5" fill="${winC}" opacity="${winOp}"/>`).join('')}
                    <polygon points="${baseX},${fy-fh} ${baseX+depth},${fy-fh-depth*0.55} ${baseX+bw+depth},${fy-fh-depth*0.55} ${baseX+bw},${fy-fh}" fill="${topC}" opacity="${faceOp}" stroke="${strokeC}" stroke-width="0.6"/>
                    <polygon points="${baseX+bw},${fy-fh} ${baseX+bw+depth},${fy-fh-depth*0.55} ${baseX+bw+depth},${fy-depth*0.55} ${baseX+bw},${fy}" fill="${sideC}" opacity="${faceOp}" stroke="${strokeC}" stroke-width="0.6"/>
                </g>`;
            }
            return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" overflow="visible">
                <ellipse cx="${baseX+bw/2+depth/2}" cy="${baseY+5}" rx="${bw/2+18}" ry="7" fill="rgba(125,42,232,0.06)"/>
                ${floorsSVG}
                <text x="${baseX+bw/2+depth/2}" y="${H+2}" text-anchor="middle" font-size="9" fill="#ccc" font-family="monospace">${maxF}F</text>
            </svg>`;
        }

        const bParams = basics['地主可分配面積'] || {};
        const tParams = basics['土地歸戶表'] || {};
        const p1Init = tParams['合計法定容積'] ?? 2.25;
        const p2Init = tParams['地主法定容積佔比'] ?? 0.58;
        const p3Init = tParams['都更獎勵容積'] ?? 0.5;
        const jrInit = tParams['合建分取'] ?? 1.58;

        wrapper.innerHTML = `
            <div style="padding: 20px 40px 0 40px; display: flex; justify-content: center;">
                <div style="position: relative; width: 100%; max-width: 400px;">
                    <i class="fa-solid fa-magnifying-glass" style="position: absolute; left: 15px; top: 50%; transform: translateY(-50%); color: #888;"></i>
                    <input type="text" id="e-search" placeholder="搜尋所有權人..."
                        style="width: 100%; padding: 12px 12px 12px 40px; border-radius: 50px; border: 1px solid #ccc; font-size: 16px; outline: none;">
                </div>
            </div>
            <div id="e-summary-bar" class="e-summary-bar"></div>
            <div id="e-grid" class="e-grid"></div>
        `;

        function renderE() {
            const tP = basics['土地歸戶表'] || {};
            const _legalFar  = tP['合計法定容積']       ?? 2.25;
            const _legalOR   = tP['地主法定容積佔比']   ?? 0.58;
            const _bonusFar  = tP['都更獎勵容積']        ?? 0.5;
            const _bonusOR   = tP['地主獎勵容積佔比']   ?? 0.5;
            const _disastFar = tP['防災都更獎勵容積']   ?? 0.3;
            const _disastOR  = tP['地主防災都更佔比']   ?? 0.5;
            const _jr        = tP['合建分取']            ?? 1.58;
            // backward compat for estProp display in E (基本分析): use with-disaster allocation
            // estProp = totalHeldPing * legalFar * legalOR + totalHeldPing*legalFar*bonusFar*bonusOR + totalHeldPing*legalFar*disastFar*disastOR
            // grandAlloc = estProp * _jr

            let personData = {};
            for (let landId in data) {
                const rec = data[landId];
                const area = rec['土地面積']['面積']||0;
                const owners = rec['所有權人']||[];
                for (let i=0; i<owners.length; i++) {
                    const nm = owners[i];
                    if (!personData[nm]) personData[nm] = {
                        name:nm, lands:[], totalHeldM2:0, totalHeldPing:0,
                        origMainM2:0, origSubM2:0, origIndoorPing:0,
                        buildNo:'', buildAddr:'', floor:''
                    };
                    const pd = personData[nm];
                    const lscope = Array.isArray(rec['土地面積']['權利範圍']) ? rec['土地面積']['權利範圍'][i] : (rec['土地面積']['權利範圍']||0);
                    pd.totalHeldM2   += area * lscope;
                    pd.totalHeldPing += area * lscope * PING_FACTOR;
                    if (!pd.lands.includes(landId)) pd.lands.push(landId);
                    const bArea  = parseFloat((rec['建物面積']||[])[i])||0;
                    const bSub   = parseFloat((rec['附屬建物面積']||[])[i])||0;
                    const bsNum  = rec['權利範圍_num'] ? (rec['權利範圍_num'][i]||1) : 1;
                    const bsDen  = rec['權利範圍_den'] ? (rec['權利範圍_den'][i]||1) : 1;
                    const bScope = bsNum / bsDen;
                    pd.origMainM2    += bArea;
                    pd.origSubM2     += bSub;
                    pd.origIndoorPing += (bArea + bSub) * bScope * PING_FACTOR;
                    if (!pd.buildAddr && (rec['建物門牌']||[])[i]) {
                        pd.buildNo   = (rec['建號']||[])[i]||'';
                        pd.buildAddr = (rec['建物門牌']||[])[i]||'';
                        pd.floor     = (rec['樓層']||[])[i]||'';
                    }
                }
            }

            const persons = Object.values(personData);
            const maxPing = Math.max(...persons.map(p=>p.totalHeldPing), 1);
            let grandAlloc = 0;
            persons.forEach(p => {
                const ownerLegal  = p.totalHeldPing * _legalFar * _legalOR;
                const ownerBonus  = p.totalHeldPing * _legalFar * _bonusFar * _bonusOR;
                const ownerDisast = p.totalHeldPing * _legalFar * _disastFar * _disastOR;
                grandAlloc += (ownerLegal + ownerBonus + ownerDisast) * _jr;
            });
            let totalLandM2 = 0;
            for (let k in data) totalLandM2 += data[k]['土地面積']['面積']||0;

            // summary bar
            document.getElementById('e-summary-bar').innerHTML = [
                {label:'地主人數', value:persons.length, unit:'人', cls:''},
                {label:'土地總面積', value:totalLandM2.toFixed(1), unit:'m²', cls:''},
                {label:'合建分取總坪', value:grandAlloc.toFixed(2), unit:'坪', cls:'accent'},
            ].map(s=>`<div class="e-sum-item ${s.cls}"><div class="e-sum-label">${s.label}</div><div class="e-sum-value">${s.value}<span class="e-sum-unit">${s.unit}</span></div></div>`).join('');

            const grid = document.getElementById('e-grid');
            grid.innerHTML = '';

            // compute max floor per address (strip floor suffix like 一樓/二樓/1F before comparing)
            const stripFloor = addr => addr.replace(/[一二三四五六七八九十百\d]+[樓层F].*$/,'').replace(/\s+$/,'').trim();
            const maxFloorByAddr = {};
            persons.forEach(p => {
                const addr = stripFloor(p.buildAddr || p.buildNo || '');
                const f = Math.max(parseInt(p.floor) || 1, 1);
                if (!maxFloorByAddr[addr] || f > maxFloorByAddr[addr]) maxFloorByAddr[addr] = f;
            });

            persons.forEach((person, pi) => {
                const accent = ACCENT_COLORS[pi % ACCENT_COLORS.length];
                const ownerLegal  = person.totalHeldPing * _legalFar * _legalOR;
                const ownerBonus  = person.totalHeldPing * _legalFar * _bonusFar * _bonusOR;
                const ownerDisast = person.totalHeldPing * _legalFar * _disastFar * _disastOR;
                const estProp   = ownerLegal + ownerBonus + ownerDisast;
                const allocPing = estProp * _jr;
                const mainPing  = allocPing * 0.8;
                const pubPing   = allocPing * 0.2;
                const diff      = allocPing - person.origIndoorPing;
                const floorNum  = Math.max(parseInt(person.floor) || 1, 1);
                const addrKey   = stripFloor(person.buildAddr || person.buildNo || '');
                const maxFloor  = maxFloorByAddr[addrKey] || floorNum;

                const diffCls  = diff > 0.05 ? 'pos' : diff < -0.05 ? 'neg' : 'zero';
                const diffIcon = diff > 0.05 ? '▲' : diff < -0.05 ? '▼' : '—';

                const card = document.createElement('div');
                card.className = 'e-card';
                card.style.animationDelay = `${pi*0.06}s`;

                card.innerHTML = `
                    <div class="e-card-header">
                        <div class="e-card-dot" style="background:${accent}"></div>
                        <span class="e-card-name">${person.name.replace(/\(.*\)/,'')}</span>
                        <span class="e-card-badge">${person.lands.length} 筆</span>
                    </div>
                    <div class="e-card-addr">${person.buildAddr||person.buildNo||'—'}${person.floor?' · '+person.floor:''}</div>

                    <div class="e-building-wrap">${buildingSVG3D(estProp, allocPing, accent, floorNum, maxFloor)}</div>

                    <div class="e-stats">
                        <div class="e-stat">
                            <div class="e-stat-label">土地持分</div>
                            <div class="e-stat-value">${person.totalHeldPing.toFixed(2)}<span class="e-stat-unit">坪</span></div>
                        </div>
                        <div class="e-stat">
                            <div class="e-stat-label">持分面積</div>
                            <div class="e-stat-value">${person.totalHeldM2.toFixed(2)}<span class="e-stat-unit">m²</span></div>
                        </div>
                        <div class="e-stat purple">
                            <div class="e-stat-label">預估產權</div>
                            <div class="e-stat-value">${estProp.toFixed(2)}<span class="e-stat-unit">坪</span></div>
                        </div>
                        <div class="e-stat amber">
                            <div class="e-stat-label">合建分取</div>
                            <div class="e-stat-value">${allocPing.toFixed(2)}<span class="e-stat-unit">坪</span></div>
                        </div>
                    </div>

                    <div class="e-bars">
                        <div class="e-bar-row">
                            <span class="e-bar-lbl">主建物</span>
                            <div class="e-bar-track"><div class="e-bar-fill" style="width:${Math.min(mainPing/Math.max(estProp,0.01)*100,100).toFixed(1)}%;background:${accent}"></div></div>
                            <span class="e-bar-val">${mainPing.toFixed(1)}坪</span>
                        </div>
                        <div class="e-bar-row">
                            <span class="e-bar-lbl">公設</span>
                            <div class="e-bar-track"><div class="e-bar-fill" style="width:${Math.min(pubPing/Math.max(estProp,0.01)*100,100).toFixed(1)}%;background:#d0b8f8"></div></div>
                            <span class="e-bar-val">${pubPing.toFixed(1)}坪</span>
                        </div>
                        <div class="e-bar-row">
                            <span class="e-bar-lbl">土地持分</span>
                            <div class="e-bar-track"><div class="e-bar-fill" style="width:${Math.min(person.totalHeldPing/maxPing*100,100).toFixed(1)}%;background:#00c4cc55;border:1px solid #00c4cc88"></div></div>
                            <span class="e-bar-val">${person.totalHeldPing.toFixed(1)}坪</span>
                        </div>
                    </div>

                    <hr class="e-divider">
                    <div style="font-size:10px;color:#bbb;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">原建物資料</div>
                    <div class="e-orig-grid">
                        <div class="e-orig-item">
                            <div class="e-orig-label">主建物</div>
                            <div class="e-orig-value">${(person.origMainM2*PING_FACTOR).toFixed(2)}<span style="font-size:9px;color:#bbb;"> 坪</span></div>
                        </div>
                        <div class="e-orig-item">
                            <div class="e-orig-label">附屬建物</div>
                            <div class="e-orig-value">${(person.origSubM2*PING_FACTOR).toFixed(2)}<span style="font-size:9px;color:#bbb;"> 坪</span></div>
                        </div>
                        <div class="e-orig-item">
                            <div class="e-orig-label">室內概算</div>
                            <div class="e-orig-value">${person.origIndoorPing.toFixed(2)}<span style="font-size:9px;color:#bbb;"> 坪</span></div>
                        </div>
                    </div>
                    <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;">
                        <span style="font-size:11px;color:#bbb;">都更前後差異</span>
                        <span class="e-diff-pill ${diffCls}">${diffIcon} ${Math.abs(diff).toFixed(2)} 坪</span>
                    </div>
                `;
                grid.appendChild(card);
            });
        }

        document.getElementById('e-search').addEventListener('input', function() {
            const q = this.value.toLowerCase();
            document.querySelectorAll('#e-grid .e-card').forEach(card => {
                const name = (card.querySelector('.e-card-name')||{}).textContent||'';
                card.style.display = name.toLowerCase().includes(q) ? '' : 'none';
            });
        });
        renderE();
    }
}

// ══════════════════════════════════════════════════════════════
// Section A OCR 主流程
// ══════════════════════════════════════════════════════════════

async function startOcrImport(files, apiKey) {
    content.innerHTML = '';
    content.style.cssText = 'display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; padding:40px 20px;';

    const card = document.createElement('div');
    card.style.cssText = 'background:white; border-radius:20px; box-shadow:0 8px 40px rgba(125,42,232,0.08); border:1px solid #f0eaff; padding:36px 40px; width:100%; max-width:480px; display:flex; flex-direction:column; gap:24px;';

    card.innerHTML = `
      <div style="display:flex; align-items:center; gap:14px;">
        <div style="width:48px; height:48px; background:linear-gradient(135deg,#00c4cc,#7d2ae8); border-radius:14px; display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 4px 14px rgba(125,42,232,0.25);">
          <i class="fa-solid fa-wand-magic-sparkles" style="color:white; font-size:20px;"></i>
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:16px; font-weight:700; color:#1a1a2e; letter-spacing:-0.2px;">解析中</div>
          <div id="ocr-file-label" style="font-size:12px; color:#aaa; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>
        </div>
        <div id="ocr-count" style="font-size:13px; font-weight:600; color:var(--accent-purple); background:#f4efff; padding:5px 12px; border-radius:20px; flex-shrink:0;">0 / 0</div>
      </div>

      <div style="height:6px; background:#f0eaff; border-radius:3px; overflow:hidden;">
        <div id="ocr-bar" style="height:100%; width:0%; background:var(--header-bg); border-radius:3px; transition:width 0.35s ease;"></div>
      </div>

      <div id="ocr-chips" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(90px, 1fr)); gap:8px;"></div>
    `;
    content.appendChild(card);

    // ── chip 工具 ──
    function makeChip(id, label) {
        const chip = document.createElement('div');
        chip.id = id;
        chip.style.cssText = 'background:#fdfcff; border:1.5px solid #ede8ff; border-radius:10px; padding:8px 10px; display:flex; align-items:center; gap:7px; font-size:12px; font-weight:500; color:#888; transition:all 0.2s;';
        chip.innerHTML = `<div class="cdot" style="width:7px;height:7px;border-radius:50%;background:#ddd;flex-shrink:0;"></div><span>${label}</span>`;
        document.getElementById('ocr-chips').appendChild(chip);
    }

    function setChip(id, state) {
        const chip = document.getElementById(id);
        if (!chip) return;
        const cfg = {
            wait:       {b:'#ede8ff', d:'#ddd',     c:'#aaa',         anim:false},
            processing: {b:'#7d2ae8', d:'#7d2ae8',  c:'#7d2ae8',      anim:true},
            done:       {b:'#d1fae5', d:'#10b981',  c:'#10b981',      anim:false},
            error:      {b:'#fee2e2', d:'#ef4444',  c:'#ef4444',      anim:false},
        };
        const c = cfg[state] || cfg.wait;
        chip.style.borderColor = c.b;
        chip.style.color = c.c;
        const dot = chip.querySelector('.cdot');
        dot.style.background = c.d;
        dot.style.animation = c.anim ? 'pulse-dot 1s infinite' : 'none';
        if (state === 'done') chip.style.background = '#f0fdf4';
        if (state === 'error') chip.style.background = '#fff5f5';
    }

    // ── 主流程 ──
    let allText = '';

    for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        const fileLabel = document.getElementById('ocr-file-label');
        if (fileLabel) fileLabel.textContent = `${fi+1} / ${files.length}  ${file.name}`;

        let pdf;
        try {
            const buf = await file.arrayBuffer();
            pdf = await pdfjsLib.getDocument({
                data: buf,
                cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/',
                cMapPacked: true
            }).promise;
        } catch(e) { continue; }

        const numPages = pdf.numPages;

        const chipsEl = document.getElementById('ocr-chips');
        if (chipsEl) chipsEl.innerHTML = '';
        for (let p = 1; p <= numPages; p++) makeChip(`cp-f${fi}-p${p}`, `第 ${p} 頁`);

        const bar = document.getElementById('ocr-bar');
        const countEl = document.getElementById('ocr-count');
        let done = 0;

        const pageTexts = new Array(numPages).fill('');

        const tasks = Array.from({length: numPages}, (_, idx) => async () => {
            const n = idx + 1;
            const chipId = `cp-f${fi}-p${n}`;
            setChip(chipId, 'processing');
            try {
                const page = await pdf.getPage(n);
                const vp = page.getViewport({scale: 4});
                const cvs = document.createElement('canvas');
                cvs.width = vp.width; cvs.height = vp.height;
                const ctx = cvs.getContext('2d');
                ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cvs.width, cvs.height);
                await page.render({canvasContext: ctx, viewport: vp}).promise;
                const b64 = cvs.toDataURL('image/png').split(',')[1];
                const text = await callGoogleVision(apiKey, b64);
                pageTexts[idx] = text || '';
                setChip(chipId, text ? 'done' : 'done');
            } catch(e) {
                setChip(chipId, 'error');
            }
            done++;
            if (bar)     bar.style.width = `${Math.round(done/numPages*100)}%`;
            if (countEl) countEl.textContent = `${done} / ${numPages} 頁`;
        });

        await runConcurrent(tasks, 2);
        allText += pageTexts.map((t, i) => `\n--- Page ${i+1} ---\n${t}`).join('') + '\n';
    }

    const ocrResult = extractTranscriptData(allText);
    convertOcrToProjectData(ocrResult);

    if (typeof window.saveProjectToLocal === 'function') window.saveProjectToLocal();

    const bar = document.getElementById('ocr-bar');
    if (bar) bar.style.width = '100%';

    // 謄本匯入後：自動批次計算所有可算的增值稅
    await autoCalcAllTaxSilent();

    if (typeof window.saveProjectToLocal === 'function') window.saveProjectToLocal();

    setTimeout(() => {
        document.getElementById('A').classList.remove('active');
        document.getElementById('B').classList.add('active');
        show('B');
    }, 1000);
}

// ══════════════════════════════════════════════════════════════
// Google Vision API（含重試）
// ══════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callGoogleVision(apiKey, base64, attempt = 1) {
    const MAX = 4;
    let resp;
    try {
        resp = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`,
            {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({requests: [{
                    image: {content: base64},
                    features: [{type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1}],
                    imageContext: {languageHints: ['zh-TW', 'zh-Hant']}
                }]})
            }
        );
    } catch(e) {
        if (attempt < MAX) { await sleep(1000 * attempt); return callGoogleVision(apiKey, base64, attempt+1); }
        throw new Error(`網路錯誤：${e.message}`);
    }

    // 429 / 403 → 速率限制，自動重試
    if (resp.status === 429 || (resp.status === 403 && attempt < MAX)) {
        await sleep(1500 * attempt);
        return callGoogleVision(apiKey, base64, attempt+1);
    }

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({error: {message: `HTTP ${resp.status}`}}));
        const msg = err.error?.message || `HTTP ${resp.status}`;
        if (resp.status === 400 && msg.includes('API_KEY')) throw new Error('API Key 無效，請確認已啟用 Cloud Vision API');
        if (resp.status === 403) throw new Error('權限不足：請確認已啟用 Cloud Vision API');
        throw new Error(msg);
    }

    const result = await resp.json();
    const ann = result.responses?.[0];
    if (ann?.error) throw new Error(`Vision API：${ann.error.message}`);
    return (ann?.fullTextAnnotation?.text || ann?.textAnnotations?.[0]?.description || '').trim();
}

async function runConcurrent(tasks, concurrency) {
    const results = new Array(tasks.length);
    let idx = 0;
    async function worker() {
        while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); }
    }
    await Promise.all(Array.from({length: concurrency}, worker));
    return results;
}

// ══════════════════════════════════════════════════════════════
// OCR 文字解析引擎（適用 Google Vision 的換行文字）
// ══════════════════════════════════════════════════════════════

function extractTranscriptData(rawText) {
    let text = rawText
        .replace(/={3,}/g, '')
        .replace(/-{3,}\s*Page\s*\d+\s*-{3,}/gi, '\n')
        .replace(/〈[^〉]*〉/g, '')
        .replace(/※注意：[\s\S]*?(?=\n[^\s]|$)/gm, '');

    const parts = text.split(/(?=土地登記第[一二]類謄本|建物登記第[一二]類謄本)/);
    const result = {};

    for (const part of parts) {
        if (!part.trim()) continue;
        const typeMatch = part.match(/(土地|建物)登記第(一|二)類謄本/);
        if (!typeMatch) continue;

        const type = typeMatch[1], category = typeMatch[2];
        let section = '', number = '';
        const hm = part.match(/([\u4e00-\u9fa5]+段(?:[\u4e00-\u9fa5]+小段)?)[\s　]*([0-9-]+)[\s　]*(?:地號|建號)/);
        if (hm) { section = hm[1]; number = hm[2]; }

        const key = `${section}_${number}` || `unknown_${Math.random()}`;
        if (!result[key]) result[key] = {謄本種類: type, 謄本類別: category, 地段: section, 號碼: number, 標示部: {}, 所有權部: []};

        if (type === '土地') {
            const aM  = part.match(/面\s*積\s*[:：]?\s*[*＊]*\s*([0-9.]+)\s*平方公尺/);
            const aM2 = !aM ? part.match(/面\s*積\s*[:：]?\s*[*＊]*\s*([0-9.]+)/) : null;
            const uM  = part.match(/使用地類別\s*[:：]?\s*(?:（|[(])?([^)\n）]{0,20}?)(?:（|[)）]|\n|民國|公告|地上|登記)/);
            const vM  = part.match(/公告土地現值\s*[:：]?\s*[*＊]*([0-9,]+)\s*元/);
            const vM2 = !vM ? part.match(/公告土地現值\s*[:：]?\s*[*＊]*([0-9,]+)/) : null;
            const bM  = part.match(/地上建物建號\s*[:：]\s*共\s*(\d+)\s*棟/);
            if (!result[key].標示部.面積) {
                result[key].標示部 = {
                    面積: aM  ? parseFloat(aM[1])  : (aM2 ? parseFloat(aM2[1]) : null),
                    使用地類別: (uM && uM[1] !== '空白') ? uM[1].trim() : '',
                    公告土地現值: vM ? parseInt(vM[1].replace(/,/g,''),10) : (vM2 ? parseInt(vM2[1].replace(/,/g,''),10) : null),
                    地上建物建號棟數: bM ? parseInt(bM[1],10) : null
                };
            }
        } else {
            const adM  = part.match(/建物門牌\s*[:：]\s*(.*?)(?:\n|建物坐落|主要|層數)/);
            const ldM  = part.match(/建物坐落地號\s*[:：]\s*(.*?)(?:\n|主要)/);
            const uM   = part.match(/主要用途\s*[:：]\s*(.*?)(?:\n|主要建材)/);
            const flrM = part.match(/層數\s*[:：]\s*0*(\d+)\s*層/);
            const lvM  = part.match(/層次\s*[:：]\s*(.*?)(?:\n|層次面積|總面積)/);
            const flAM = part.match(/層次面積\s*[:：]?\s*[*＊]*\s*([0-9.]+)/);
            const totM = part.match(/總面積\s*[:：]?\s*[*＊]*\s*([0-9.]+)/);
            // 附屬建物：用途 + 面積
            // 謄本格式：「附屬建物用途：平台」在左、「面積：*1.66平方公尺」在右（同一行）
            // OCR 掃出來同一行文字間只有空白分隔，例如：
            //   「附屬建物用途：平台\n\n面積：******1.66平方公尺\n」
            // 或是同行：「附屬建物用途：平台          面積：******1.66平方公尺」
            // 策略：只取「附屬建物用途」那一行（到下一個換行前）的文字，從中找面積
            const subUseM  = part.match(/附屬建物用途\s*[:：]\s*(.*?)(?:\n|面積|其他登記|所有權部)/);
            // 附屬建物面積擷取策略：
            // 已確認 OCR 格式：附屬建物用途:平台\n其他登記事項:...\n***\n總面積:**54.92\n層次面積:**54.92\n面積:**1.66平方公尺\n建物所有權部
            // 附屬建物面積特徵：換行後緊接「面積:」（前面沒有「總」「層次」等前綴字）
            let subAreaVal = null;
            {
                const useIdx = part.indexOf('附屬建物用途');
                const ownIdx = part.search(/建物所有權部|所有權部/);
                if (useIdx !== -1) {
                    const endIdx = ownIdx !== -1 ? ownIdx : useIdx + 800;
                    const block = part.slice(useIdx, endIdx);
                    // 用換行錨點：只抓 \n 後面直接是「面積:」的行（總面積、層次面積前面有其他字）
                    const hits = [...block.matchAll(/\n面積\s*[:：]\s*[*＊]*\s*([0-9.]+)\s*平方公尺/g)];
                    if (hits.length > 0) {
                        subAreaVal = parseFloat(hits[hits.length - 1][1]);
                    }
                }
            }
            let sitSec = '', sitLot = '';
            if (ldM) { const sm = ldM[1].match(/([^\d]+)([\d-]+)/); if(sm) {sitSec = sm[1]; sitLot = sm[2];} }
            if (!result[key].標示部.面積) {
                result[key].標示部 = {
                    建物門牌: adM ? adM[1].trim() : '',
                    建物坐落地號_地段: sitSec.trim(),
                    建物坐落地號_地號: sitLot,
                    主要用途: uM ? uM[1].trim() : '',
                    層數: flrM ? parseInt(flrM[1],10) : null,
                    層次: lvM ? lvM[1].trim() : '',
                    層次面積: flAM ? parseFloat(flAM[1]) : null,
                    面積: totM ? parseFloat(totM[1]) : null,
                    附屬建物用途: subUseM ? subUseM[1].trim() : '',
                    附屬建物面積: subAreaVal || null
                };
            }
        }

        mergeOwners(result[key].所有權部, parseOwners(part, type));
    }
    return result;
}

function parseOwners(text, type) {
    const owners = [];
    const chunks = text.split(/(?:[\(（]\d+[\)）]\s*)?登記次序\s*[:：]\s*/);

    for (let i = 1; i < chunks.length; i++) {
        const orderM = chunks[i].match(/^([0-9]+(?:-[0-9]+)?)/);
        if (!orderM) continue;
        const order = orderM[1];
        if (order.includes('-')) continue;

        const prevTail = chunks[i-1].slice(-200);
        const seg = prevTail + chunks[i];
        const owner = {登記次序: order};

        const nameM   = seg.match(/(?:所有權人|管理者)\s*[:：]\s*([\u4e00-\u9fa5a-zA-Z＊*\s]{1,20}?)(?=\s*\n|\s*統一編號|\s*住\s*址|\s*出生|\s*權利範圍)/);
        const idM     = seg.match(/統一編號\s*[:：]\s*([A-Za-z0-9＊*]{6,12})/);
        const addrM   = seg.match(/住\s*[址所]\s*[:：]\s*([\s\S]*?)(?=\s*(?:出生日期|權利範圍|權狀字號|當期申報|前次移轉|歷次取得|相關他項|其他登記|登記次序|$))/);
        const birthM  = seg.match(/出生日期\s*[:：]\s*(民國\d+年\d+月\d+日)/);
        const shareM  = seg.match(/權利範圍\s*[:：]\s*(?:全部|[*＊]*)?\s*(\d+)\s*分之\s*(\d+)/);
        const reasonM = seg.match(/登記原因\s*[:：]\s*([\u4e00-\u9fa5a-zA-Z0-9]+)/);
        const dateM   = seg.match(/登記日期\s*[:：]\s*(民國\d+年\d+月\d+日)/);

        owner.所有權人名稱 = nameM ? nameM[1].trim() : '';
        owner.統一編號     = idM   ? idM[1].trim()   : '';
        owner.住址         = addrM ? addrM[1].replace(/\s+/g,'').trim() : '';
        if (birthM)  owner.出生日期 = birthM[1];
        if (reasonM) owner.登記原因 = reasonM[1];
        if (dateM)   owner.登記日期 = dateM[1];

        if (shareM) {
            owner.權利範圍 = {分子: parseInt(shareM[2],10), 分母: parseInt(shareM[1],10)};
        } else if (/全部/.test(seg.slice(0,500))) {
            owner.權利範圍 = '全部';
        }

        if (type === '土地') {
            const tM = seg.match(/前次移轉現值[^0-9]*(\d+)\s*年\s*(\d+)\s*月[^0-9]*([0-9,]+(?:\.\d+)?)\s*元/);
            if (tM) owner.前次移轉現值 = {
                年: parseInt(tM[1],10), 月: parseInt(tM[2],10),
                地價每平方公尺: parseFloat(tM[3].replace(/,/g,''))
            };
        }

        if (owner.所有權人名稱 || owner.統一編號 || owner.權利範圍) owners.push(owner);
    }
    return owners;
}

function mergeOwners(target, incoming) {
    incoming.forEach(n => {
        const ex = target.find(o => o.登記次序 === n.登記次序);
        if (ex) {
            if (!ex.所有權人名稱 && n.所有權人名稱) ex.所有權人名稱 = n.所有權人名稱;
            if (!ex.統一編號     && n.統一編號)     ex.統一編號     = n.統一編號;
            if (!ex.住址         && n.住址)         ex.住址         = n.住址;
            if (!ex.出生日期     && n.出生日期)     ex.出生日期     = n.出生日期;
            if (!ex.登記原因     && n.登記原因)     ex.登記原因     = n.登記原因;
            if (!ex.登記日期     && n.登記日期)     ex.登記日期     = n.登記日期;
            if (!ex.權利範圍     && n.權利範圍)     ex.權利範圍     = n.權利範圍;
            if (!ex.前次移轉現值 && n.前次移轉現值) ex.前次移轉現值 = n.前次移轉現值;
        } else {
            target.push(n);
        }
    });
}

// ══════════════════════════════════════════════════════════════
// OCR 結果 → 專案 data 格式轉換
// ══════════════════════════════════════════════════════════════

function convertOcrToProjectData(ocrResult) {
    // 第一輪：土地謄本
    for (const key in ocrResult) {
        const entry = ocrResult[key];
        if (entry.謄本種類 !== '土地') continue;

        const landId = entry.號碼;
        if (!landId) continue;

        if (!data[landId]) {
            data[landId] = {
                "所有權人": [],
                "土地面積": {"面積": entry.標示部?.面積 || 0, "權利範圍": []},
                "他項權利": "",
                "公告現值": [], "年月": [],
                "當期公告現值": entry.標示部?.公告土地現值 || 0,
                "增值稅預估(自用)": [], "增值稅預估(一般)": [],
                "建號": [], "建物門牌": [], "樓層": [], "建物面積": [],
                "附屬建物用途": [], "附屬建物面積": [],
                "權利範圍": [], "所有權地址": [], "電話": "",
                "增值稅試算(自用)": [], "增值稅試算(一般)": [],
                "使用分區": "商", "基準容積率": 4.4, "建蔽率": 0.7
            };
        }

        for (const owner of (entry.所有權部 || [])) {
            const name = (owner.所有權人名稱 || '').trim();
            if (!name) continue;
            const id = (owner.統一編號 || '').trim();
            const fullName = id ? `${name}(${id})` : name;
            if (data[landId]["所有權人"].includes(fullName)) continue;

            let scope = 1.0;
            if (owner.權利範圍) {
                if (owner.權利範圍 === '全部') scope = 1.0;
                else if (typeof owner.權利範圍 === 'object')
                    scope = (owner.權利範圍.分子 || 0) / (owner.權利範圍.分母 || 1);
            }

            const prev = owner.前次移轉現值;
            data[landId]["所有權人"].push(fullName);
            data[landId]["土地面積"]["權利範圍"].push(scope);
            data[landId]["所有權地址"].push(owner.住址 || '');
            data[landId]["年月"].push(prev ? `${prev.年}/${prev.月}` : '');
            data[landId]["公告現值"].push(prev ? (prev.地價每平方公尺 || 0) : 0);
            ["增值稅預估(自用)", "增值稅預估(一般)", "建號", "建物門牌",
             "樓層", "建物面積", "附屬建物用途", "附屬建物面積", "權利範圍", "增值稅試算(自用)", "增值稅試算(一般)"]
                .forEach(k => data[landId][k].push(''));
        }
    }

    // 第二輪：建物謄本（對應回土地地號）
    for (const key in ocrResult) {
        const entry = ocrResult[key];
        if (entry.謄本種類 !== '建物') continue;
        const 標示 = entry.標示部 || {};
        const landNo = 標示.建物坐落地號_地號;
        if (!landNo || !data[landNo]) continue;

        for (const owner of (entry.所有權部 || [])) {
            const name = (owner.所有權人名稱 || '').trim();
            if (!name) continue;
            const id = (owner.統一編號 || '').trim();
            const fullName = id ? `${name}(${id})` : name;

            let idx = data[landNo]["所有權人"].indexOf(fullName);
            if (idx === -1)
                idx = data[landNo]["所有權人"].findIndex(n => n === name || n.startsWith(name + '('));
            if (idx === -1) continue;

            let bScope = 1.0;
            let bScopeNum = 1, bScopeDen = 1;
            if (owner.權利範圍) {
                if (owner.權利範圍 === '全部') { bScope = 1.0; bScopeNum = 1; bScopeDen = 1; }
                else if (typeof owner.權利範圍 === 'object') {
                    bScopeNum = owner.權利範圍.分子 || 0;
                    bScopeDen = owner.權利範圍.分母 || 1;
                    bScope = bScopeNum / bScopeDen;
                }
            }

            data[landNo]["建號"][idx]      = entry.號碼 || '';
            data[landNo]["建物門牌"][idx]  = 標示.建物門牌 || '';
            // 自動從「建物門牌」抓取樓層（若 OCR 的層次為空，支援國字）
            const _ocrFloor = 標示.層次 || '';
            const _resolvedFloor = _ocrFloor || extractFloorFromAddr(標示.建物門牌 || '');
            data[landNo]["樓層"][idx]      = _resolvedFloor;
            data[landNo]["建物面積"][idx]  = 標示.面積 || 標示.層次面積 || 0;
            data[landNo]["附屬建物用途"][idx] = 標示.附屬建物用途 || '';
            data[landNo]["附屬建物面積"][idx] = 標示.附屬建物面積 || 0;
            data[landNo]["權利範圍"][idx]  = bScope;
            if (!data[landNo]["權利範圍_num"]) data[landNo]["權利範圍_num"] = new Array(data[landNo]["所有權人"].length).fill(1);
            if (!data[landNo]["權利範圍_den"]) data[landNo]["權利範圍_den"] = new Array(data[landNo]["所有權人"].length).fill(1);
            data[landNo]["權利範圍_num"][idx] = bScopeNum;
            data[landNo]["權利範圍_den"][idx] = bScopeDen;
        }
    }
}

// ══════════════════════════════════════════════════════════════
// Chart 相關函式（不變）
// ══════════════════════════════════════════════════════════════

function createChartBlock(id, title) {
    const rawId = id.replace('chart_', '');
    const hasMissingTax = checkLandMissingTax(rawId);
    const badge = hasMissingTax
        ? `<div id="tax-badge-${CSS.escape(rawId)}" title="此地號有所有權人的增值稅尚未填入" style="position:absolute;top:10px;right:10px;width:22px;height:22px;background:#e74c3c;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-weight:900;font-size:13px;box-shadow:0 2px 6px rgba(231,76,60,0.5);z-index:10;cursor:default;animation:taxBadgePulse 2s infinite;">!</div>`
        : `<div id="tax-badge-${CSS.escape(rawId)}" style="display:none;position:absolute;top:10px;right:10px;width:22px;height:22px;background:#e74c3c;border-radius:50%;align-items:center;justify-content:center;color:white;font-weight:900;font-size:13px;box-shadow:0 2px 6px rgba(231,76,60,0.5);z-index:10;cursor:default;">!</div>`;
    return `<div class="chart-card" data-id="${rawId}" style="position:relative;">${badge}<h3 class="chart-title">${title}</h3><div class="chart-wrapper" style="position:relative;width:100%;aspect-ratio:1/1;max-width:300px;"><canvas id="canvas_${id}"></canvas><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;"><div style="font-size:13px;color:#888;margin-bottom:4px;">持分總計</div><div id="val_${id}" style="font-size:24px;font-weight:800;color:#2c3e50;">0.0</div><div id="val_ping_${id}" style="font-size:12px;color:#aaa;margin-top:2px;">0.00 坪</div></div></div><div style="margin-top:auto;padding-top:20px;width:100%;display:flex;justify-content:center;gap:10px;"><button class="btn-edit" onclick="openEditModal('${rawId}')"><i class="fa-solid fa-pen-to-square"></i> 編輯</button><button class="btn-edit" style="color:#d93025;border-color:#d93025;" onclick="deleteLand('${rawId}')"><i class="fa-solid fa-trash"></i> 刪除</button></div></div>`;
}

/** 檢查某地號是否有任何所有權人缺少增值稅 */
function checkLandMissingTax(landId) {
    const record = data[landId];
    if (!record) return false;
    const owners = record['所有權人'] || [];
    for (let i = 0; i < owners.length; i++) {
        const self = record['增值稅預估(自用)']?.[i];
        const gen  = record['增值稅預估(一般)']?.[i];
        if (self === '' || self === null || self === undefined || gen === '' || gen === null || gen === undefined) return true;
    }
    return false;
}

/** 重新整理所有地號卡片上的紅點狀態 */
function refreshAllTaxBadges() {
    for (const landId in data) {
        updateTaxBadge(landId);
    }
}

/** 更新特定地號的紅點 */
function updateTaxBadge(landId) {
    const escaped = CSS.escape(landId);
    const badge = document.getElementById(`tax-badge-${escaped}`);
    if (!badge) return;
    const missing = checkLandMissingTax(landId);
    if (missing) {
        badge.style.display = 'flex';
        badge.title = '此地號有所有權人的增值稅尚未填入';
    } else {
        badge.style.display = 'none';
    }
}

function deleteLand(id) {
    if (confirm(`確定要刪除地號「${id}」嗎？`)) {
        delete data[id];
        if (charts[`chart_${id}`]) { charts[`chart_${id}`].destroy(); delete charts[`chart_${id}`]; }
        if (typeof window.saveProjectToLocal === 'function') window.saveProjectToLocal();
        const activeTab = document.querySelector('.nav-item.active');
        if (activeTab) show(activeTab.id);
    }
}

function initChart(id) {
    const ctx = document.getElementById(`canvas_${id}`);
    if (!ctx) return;
    charts[id] = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 2, borderColor: '#ffffff' }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '55%', layout: { padding: 20 },
            plugins: { legend: { display: false }, datalabels: { color: '#ffffff', font: { weight: 'bold', size: 14 }, formatter: (value, context) => { const total = context.chart.data.datasets[0].data.reduce((a, b) => a + b, 0); return context.chart.data.labels[context.dataIndex] + '\n' + ((value / total) * 100).toFixed(1) + '%'; }, textAlign: 'center' } }
        }
    });
}

function addPerson(chartId, name, amount) {
    const chart = charts[chartId];
    if (!chart) return;
    chart.data.labels.push(name);
    chart.data.datasets[0].data.push(amount);
    chart.data.datasets[0].backgroundColor.push(colorPalette[(chart.data.labels.length - 1) % colorPalette.length]);
    chart.update();
    updateCenterTotal(chartId);
}

function updateCenterTotal(chartId) {
    const total = charts[chartId].data.datasets[0].data.reduce((a, b) => a + b, 0);
    const el = document.getElementById(`val_${chartId}`);
    if (el) el.innerText = total.toFixed(1);
    const elPing = document.getElementById(`val_ping_${chartId}`);
    if (elPing) elPing.innerText = (total * PING_FACTOR).toFixed(2) + ' 坪';
}

// ══════════════════════════════════════════════════════════════
// 新增地號 Modal
// ══════════════════════════════════════════════════════════════

function newNum() {
    if (document.getElementById('newNumModal')) return;
    document.body.insertAdjacentHTML('beforeend', `<div id="newNumModal" class="modal-overlay"><div class="modal-content" style="width: 380px;"><div class="modal-header"><h3>新增地號</h3><button class="close-btn" onclick="closeNewNumModal()">&times;</button></div><div class="modal-body"><div class="form-group"><label class="field-label">* 地號</label><input type="text" id="newLandIdInput" placeholder="8888"></div><div class="form-group"><label class="field-label">* 土地總面積 (m²)</label><input type="number" id="newLandAreaInput" placeholder="100" step="0.01"></div><div class="form-group"><label class="field-label">* 所有權人姓名</label><input type="text" id="newOwnerNameInput" placeholder="王小明"></div><p id="newNumError" style="color:#d93025; display:none;"></p></div><div class="modal-footer"><button class="btn-cancel" onclick="closeNewNumModal()">取消</button><button class="btn-save" onclick="confirmNewNum()">確定</button></div></div></div>`);
}

function closeNewNumModal() { const m = document.getElementById('newNumModal'); if(m) m.remove(); }

function confirmNewNum() {
    const id   = document.getElementById('newLandIdInput').value.trim();
    const area = parseFloat(document.getElementById('newLandAreaInput').value) || 0;
    const name = document.getElementById('newOwnerNameInput').value.trim();
    if (!id || area <= 0 || !name) return;
    data[id] = { '所有權人': [name], '土地面積': {'面積': area, '權利範圍': [1]}, '他項權利': '', '公告現值': [''], '年月': [''], '當期公告現值': 0, '增值稅預估(自用)': [''], '增值稅預估(一般)': [''], '建號': [''], '建物門牌': [''], '樓層': [''], '建物面積': [''], '附屬建物用途': [''], '附屬建物面積': [''], '權利範圍': [''], '所有權地址': [''], '電話': '', '增值稅試算(自用)': [''], '增值稅試算(一般)': [''], '使用分區': "商", '基準容積率': 4.4, '建蔽率': 0.7 };
    if(typeof window.saveProjectToLocal === 'function') window.saveProjectToLocal();
    closeNewNumModal();
    show(document.querySelector('.nav-item.active').id);
    setTimeout(() => openEditModal(id), 300);
}

// ══════════════════════════════════════════════════════════════
// 編輯 Modal
// ══════════════════════════════════════════════════════════════

function openEditModal(id) {
    currentEditingId = id;
    const record = data[id];
    if(!record) return;

    document.getElementById('modalTitle').innerText = id;
    document.getElementById('editTotalArea').value = record['土地面積']['面積'];
    document.getElementById('editTotalPing').value = (record['土地面積']['面積'] * PING_FACTOR).toFixed(2);
    document.getElementById('editCurrentValue102').value = record['當期公告現值'] || '';
    document.getElementById('editOtherRights').value = record['他項權利'] || '';
    document.getElementById('phoneNumber').value = record['電話'] || '';

    const listContainer = document.getElementById('ownerList');
    listContainer.innerHTML = ''; 

    const owners = record['所有權人'];
    for(let i=0; i < owners.length; i++) {
        const landScopeVal  = Array.isArray(record['土地面積']['權利範圍']) ? record['土地面積']['權利範圍'][i] : record['土地面積']['權利範圍'];
        const landFrac = decimalToFraction(landScopeVal);
        const buildScopeVal = Array.isArray(record['權利範圍']) ? record['權利範圍'][i] : record['權利範圍'];
        const buildFrac = decimalToFraction(parseFloat(buildScopeVal) || 0);

        addOwnerRow({
            name: owners[i],
            scopeNum: landFrac.num,   scopeDen: landFrac.den,
            date:    record['年月'][i] || '',
            value:   record['公告現值'][i] || '',
            taxSelf: record['增值稅預估(自用)'][i] || '',
            taxGen:  record['增值稅預估(一般)'][i] || '',
            buildNo: record['建號'][i] || '',
            buildAddr: record['建物門牌'][i] || '',
            floor:   record['樓層'][i] || '',
            buildArea: record['建物面積'][i] || '',
            buildScopeNum: buildFrac.num, buildScopeDen: buildFrac.den,
            subBuildUse: (record['附屬建物用途'] || [])[i] || '',
            subBuildArea: (record['附屬建物面積'] || [])[i] || '',
            ownerAddr: record['所有權地址'][i] || '',
            calcTaxSelf: record['增值稅試算(自用)'][i] || '',
            calcTaxGen:  record['增值稅試算(一般)'][i] || ''
        });
    }
    document.getElementById('editModal').style.display = 'flex';
}

function closeModal() {
    document.getElementById('editModal').style.display = 'none';
    currentEditingId = null;
    const activeId = document.querySelector('.nav-item.active').id;
    if(['B','C','D','E'].includes(activeId)) show(activeId);
}

function addOwnerRow(inputData = {}, isNew = false) {
    const div = document.createElement('div');
    div.className = 'owner-card';
    const d = inputData;
    div.innerHTML = `
        <div class="owner-card-header"><strong style="color:#555;">所有權人資訊</strong><button class="btn-remove-card" onclick="this.closest('.owner-card').remove(); calculateGlobalLayout();"><i class="fa-solid fa-trash"></i> 移除</button></div>
        <div class="grid-2-col" style="margin-bottom:15px;">
            <div><span class="field-label">姓名</span><input type="text" class="input-name" value="${d.name || ''}"></div>
            <div><span class="field-label">權利範圍 (土地)</span>
                <div style="display:flex;align-items:center;gap:5px;">
                    <input type="number" class="input-scope-num" value="${d.scopeNum || 1}" step="1" oninput="calculateRow(this)">
                    <span>/</span>
                    <input type="number" class="input-scope-den" value="${d.scopeDen || 1}" step="1" oninput="calculateRow(this)">
                </div>
            </div>
        </div>
        <div class="grid-3-col" style="margin-bottom:15px;background:#f8f9fa;padding:10px;border-radius:6px;">
            <div><span class="field-label">土地持分 (m²)</span><input type="text" class="input-held-area" readonly style="border:none;background:transparent;"></div>
            <div><span class="field-label">土地持分 (坪)</span><input type="text" class="input-held-ping" readonly style="border:none;background:transparent;"></div>
            <div><span class="field-label">持分比例 (%)</span><input type="text" class="input-held-ratio" readonly style="border:none;background:transparent;"></div>
        </div>
        <div class="grid-2-col" style="margin-bottom:15px;">
            <div><span class="field-label">年月</span><input type="text" class="input-date" value="${d.date || ''}"></div>
            <div><span class="field-label">公告現值</span><input type="number" class="input-value" value="${d.value || ''}"></div>
        </div>
        <div style="margin-bottom:12px;background:linear-gradient(135deg,#f0f4ff,#faf0ff);border:1px solid #d8c8f8;border-radius:8px;padding:8px 12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span style="font-size:12px;font-weight:700;color:#7d2ae8;">⚡ 土地增值稅自動計算</span>
                <button type="button" class="btn-auto-calc-tax" onclick="autoCalcTax(this)" style="background:linear-gradient(135deg,#7d2ae8,#00c4cc);color:white;border:none;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px;flex-shrink:0;"><i class="fa-solid fa-calculator"></i> 自動計算</button>
            </div>
            <div class="manual-cpi-block" style="display:none;margin-top:8px;padding:8px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;">
                <div style="font-size:11px;color:#795548;margin-bottom:6px;">📋 前次移轉早於民國70年，請至 <a href="https://www.stat.gov.tw/cp.aspx?n=2665" target="_blank" style="color:#7d2ae8;font-weight:600;">主計總處第四點「各年月為基期之消費者物價總指數－稅務專用」</a> 查詢後手動填入：</div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <label style="font-size:12px;color:#555;white-space:nowrap;">消費者物價總指數</label>
                    <input type="number" class="input-manual-cpi" placeholder="例：209.50" step="0.01" min="0" style="width:120px;padding:4px 8px;border:1px solid #bbb;border-radius:4px;font-size:13px;">
                    <span style="font-size:11px;color:#888;">%（填入後再按自動計算）</span>
                </div>
            </div>
            <div class="tax-calc-status" style="font-size:11px;color:#888;line-height:1.5;"></div>
        </div>
        <div class="grid-2-col" style="margin-bottom:24px;border-bottom:1px dashed #ddd;padding-bottom:15px;">
            <div><span class="field-label">增值稅預估(自用)</span><input type="number" class="input-tax-self" value="${d.taxSelf || ''}"></div>
            <div><span class="field-label">增值稅預估(一般)</span><input type="number" class="input-tax-gen" value="${d.taxGen || ''}"></div>
        </div>
        <h4 style="font-size:13px;color:var(--accent-purple);margin-bottom:10px;border-left:3px solid var(--accent-purple);padding-left:8px;">建物詳細資料</h4>
        <div class="grid-2-col" style="margin-bottom:15px;">
            <div><span class="field-label">建號</span><input type="text" class="input-build-no" value="${d.buildNo || ''}"></div>
            <div><span class="field-label">建物門牌</span><input type="text" class="input-build-addr" value="${d.buildAddr || ''}"></div>
        </div>
        <div class="grid-2-col" style="margin-bottom:15px;">
            <div><span class="field-label">樓層</span><input type="text" class="input-floor" value="${d.floor || ''}"></div>
            <div><span class="field-label">建物總面積 (m²)</span><input type="number" class="input-build-area" value="${d.buildArea || ''}" oninput="calculateBuildingRow(this)"></div>
        </div>
        <div class="grid-2-col" style="margin-bottom:15px;">
            <div><span class="field-label">建物權利範圍</span>
                <div style="display:flex;align-items:center;gap:5px;">
                    <input type="number" class="input-build-scope-num" value="${d.buildScopeNum || 1}" step="1" oninput="calculateBuildingRow(this)">
                    <span>/</span>
                    <input type="number" class="input-build-scope-den" value="${d.buildScopeDen || 1}" step="1" oninput="calculateBuildingRow(this)">
                </div>
            </div>
            <div><span class="field-label">所有權地址</span><input type="text" class="input-owner-addr" value="${d.ownerAddr || ''}"></div>
        </div>
        <div class="grid-2-col" style="margin-bottom:15px;">
            <div><span class="field-label">附屬建物用途</span><input type="text" class="input-sub-build-use" value="${d.subBuildUse || ''}"></div>
            <div><span class="field-label">附屬建物面積 (m²)</span><input type="number" class="input-sub-build-area" value="${d.subBuildArea || ''}" step="0.01" oninput="const p=this.closest('.owner-card').querySelector('.readonly-sub-build-ping'); if(p) p.value=this.value?(parseFloat(this.value)*0.3025).toFixed(2):''"></div>
        </div>
        <div class="grid-2-col" style="margin-bottom:15px;background:#f8f9fa;padding:10px;border-radius:6px;">
            <div><span class="field-label">附屬建物面積 (坪)</span><input type="text" class="readonly-sub-build-ping" readonly style="border:none;background:transparent;" value="${d.subBuildArea ? (parseFloat(d.subBuildArea)*0.3025).toFixed(2) : ''}"></div>
        </div>
        <div class="grid-3-col" style="margin-bottom:15px;background:#f8f9fa;padding:10px;border-radius:6px;">
            <div><span class="field-label">建物總坪數</span><input type="text" class="readonly-build-total-ping" readonly style="border:none;background:transparent;"></div>
            <div><span class="field-label">建物持分 (m²)</span><input type="text" class="readonly-build-held-area" readonly style="border:none;background:transparent;"></div>
            <div><span class="field-label">建物持分 (坪)</span><input type="text" class="readonly-build-held-ping" readonly style="border:none;background:transparent;"></div>
        </div>
        <div class="grid-2-col">
            <div><span class="field-label">增值稅試算(自用)</span><input type="number" class="input-calc-tax-self" value="${d.calcTaxSelf || ''}"></div>
            <div><span class="field-label">增值稅試算(一般)</span><input type="number" class="input-calc-tax-gen" value="${d.calcTaxGen || ''}"></div>
        </div>
    `;
    document.getElementById('ownerList').appendChild(div);
    calculateRow(div.querySelector('.input-scope-num'));
    calculateBuildingRow(div.querySelector('.input-build-area'));
    if (isNew) div.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function calculateGlobalLayout() {
    const area = parseFloat(document.getElementById('editTotalArea').value) || 0;
    document.getElementById('editTotalPing').value = (area * PING_FACTOR).toFixed(2);
    document.querySelectorAll('.owner-card').forEach(row => calculateRow(row.querySelector('.input-scope-num')));
}

function calculateRow(input) {
    if(!input) return;
    const card = input.closest('.owner-card');
    const totalArea = parseFloat(document.getElementById('editTotalArea').value) || 0;
    const num = parseFloat(card.querySelector('.input-scope-num').value) || 0;
    const den = parseFloat(card.querySelector('.input-scope-den').value) || 1;
    const scope = num / den;
    const heldArea = totalArea * scope;
    card.querySelector('.input-held-area').value = heldArea.toFixed(2);
    card.querySelector('.input-held-ping').value = (heldArea * PING_FACTOR).toFixed(2);
    card.querySelector('.input-held-ratio').value = (scope * 100).toFixed(2);
}

function calculateBuildingRow(input) {
    if(!input) return;
    const card = input.closest('.owner-card');
    const bArea = parseFloat(card.querySelector('.input-build-area').value) || 0;
    const bNum  = parseFloat(card.querySelector('.input-build-scope-num').value) || 0;
    const bDen  = parseFloat(card.querySelector('.input-build-scope-den').value) || 1;
    const bScope = bNum / bDen;
    card.querySelector('.readonly-build-total-ping').value  = (bArea * PING_FACTOR).toFixed(2);
    card.querySelector('.readonly-build-held-area').value   = (bArea * bScope).toFixed(2);
    card.querySelector('.readonly-build-held-ping').value   = (bArea * bScope * PING_FACTOR).toFixed(2);
}

function saveEdit() {
    if(!currentEditingId) return;
    const record = data[currentEditingId];
    const newArea = parseFloat(document.getElementById('editTotalArea').value) || 0;
    if (newArea <= 0) return alert("土地面積需大於 0");

    const rows = document.querySelectorAll('.owner-card');
    let o=[], s=[], d=[], v=[], ts=[], tg=[], bn=[], ba=[], fl=[], b_area=[], bs=[], oa=[], cts=[], ctg=[], sbu=[], sba=[];
    let _landScopeNums=[], _landScopeDens=[], _buildScopeNums=[], _buildScopeDens=[];

    rows.forEach(row => {
        const name = row.querySelector('.input-name').value.trim();
        if(name) {
            o.push(name);
            const _sNum = parseFloat(row.querySelector('.input-scope-num').value)||0;
            const _sDen = parseFloat(row.querySelector('.input-scope-den').value)||1;
            s.push(_sNum / _sDen);
            _landScopeNums.push(_sNum);
            _landScopeDens.push(_sDen);
            d.push(row.querySelector('.input-date').value);
            v.push(parseInt(row.querySelector('.input-value').value) || 0);
            ts.push(parseInt(row.querySelector('.input-tax-self').value) || 0);
            tg.push(parseInt(row.querySelector('.input-tax-gen').value) || 0);
            bn.push(row.querySelector('.input-build-no').value);
            ba.push(row.querySelector('.input-build-addr').value);
            fl.push(row.querySelector('.input-floor').value);
            b_area.push(parseFloat(row.querySelector('.input-build-area').value) || 0);
            const _bsNum = parseFloat(row.querySelector('.input-build-scope-num').value)||0;
            const _bsDen = parseFloat(row.querySelector('.input-build-scope-den').value)||1;
            bs.push(_bsNum / _bsDen);
            _buildScopeNums.push(_bsNum);
            _buildScopeDens.push(_bsDen);
            oa.push(row.querySelector('.input-owner-addr').value);
            sbu.push(row.querySelector('.input-sub-build-use').value || '');
            sba.push(parseFloat(row.querySelector('.input-sub-build-area').value) || 0);
            cts.push(parseInt(row.querySelector('.input-calc-tax-self').value) || 0);
            ctg.push(parseInt(row.querySelector('.input-calc-tax-gen').value) || 0);
        }
    });

    if(o.length === 0) return alert("請至少輸入一位所有權人");

    record['所有權人']=o; record['土地面積']['面積']=newArea; record['土地面積']['權利範圍']=s;
    record['土地面積']['權利範圍_num']=_landScopeNums; record['土地面積']['權利範圍_den']=_landScopeDens; record['年月']=d; record['公告現值']=v;
    record['當期公告現值']=parseFloat(document.getElementById('editCurrentValue102').value)||0;
    record['他項權利']=document.getElementById('editOtherRights').value;
    record['電話']=document.getElementById('phoneNumber').value;
    record['增值稅預估(自用)']=ts; record['增值稅預估(一般)']=tg;
    // 自動從「建物門牌」抓取樓層填入「樓層」欄位（若樓層為空，支援國字）
    const flAutoFilled = fl.map((floor, i) => {
        if (floor) return floor;
        return extractFloorFromAddr(ba[i] || '');
    });
    record['建號']=bn; record['建物門牌']=ba; record['樓層']=flAutoFilled; record['建物面積']=b_area; record['附屬建物用途']=sbu; record['附屬建物面積']=sba; record['權利範圍']=bs;
    record['權利範圍_num']=_buildScopeNums; record['權利範圍_den']=_buildScopeDens; record['所有權地址']=oa;
    record['增值稅試算(自用)']=cts; record['增值稅試算(一般)']=ctg;

    if(charts[`chart_${currentEditingId}`]) {
        const c = charts[`chart_${currentEditingId}`];
        c.data.labels = o; c.data.datasets[0].data = o.map((_,i)=>newArea*s[i]);
        c.data.datasets[0].backgroundColor = o.map((_,i)=>colorPalette[i%colorPalette.length]);
        c.update(); updateCenterTotal(`chart_${currentEditingId}`);
    }
    if(typeof window.saveProjectToLocal === 'function') window.saveProjectToLocal();
    updateTaxBadge(currentEditingId);
    closeModal();
}

/**
 * 顯示缺少增值稅的警告 popup
 * @param {string[]} missingLands  缺少增值稅的地號陣列
 * @param {Function} onIgnore      使用者按「忽略並匯出」時的 callback
 */
function showMissingTaxWarning(missingLands, onIgnore) {
    // 若已存在就先移除
    const existing = document.getElementById('taxWarningOverlay');
    if (existing) existing.remove();

    const landList = missingLands.slice(0, 8).map(id => `<span style="display:inline-block;background:#fdecea;color:#c0392b;border:1px solid #f5c6c6;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px;font-weight:600;">${id}</span>`).join('');
    const moreText = missingLands.length > 8 ? `<span style="font-size:12px;color:#999;"> 等共 ${missingLands.length} 筆...</span>` : '';
    const todayKey = 'taxWarningSuppressed_' + new Date().toISOString().slice(0, 10);

    const overlay = document.createElement('div');
    overlay.id = 'taxWarningOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);display:flex;justify-content:center;align-items:center;z-index:9999;backdrop-filter:blur(4px);animation:fadeInOverlay 0.2s ease;';

    overlay.innerHTML = `
        <div style="background:white;width:480px;max-width:95%;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;animation:slideUpModal 0.25s ease;">
            <!-- Header -->
            <div style="background:linear-gradient(135deg,#e74c3c,#c0392b);padding:20px 24px;display:flex;align-items:center;gap:12px;">
                <div style="width:40px;height:40px;background:rgba(255,255,255,0.2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">⚠️</div>
                <div>
                    <div style="color:white;font-size:17px;font-weight:700;letter-spacing:0.3px;">增值稅資料尚未完整</div>
                    <div style="color:rgba(255,255,255,0.8);font-size:12px;margin-top:2px;">匯出前請確認所有欄位已填寫</div>
                </div>
            </div>
            <!-- Body -->
            <div style="padding:24px;">
                <p style="color:#444;font-size:14px;line-height:1.7;margin-bottom:16px;">
                    以下 <strong style="color:#e74c3c;">${missingLands.length} 筆地號</strong> 中，有所有權人的<br>
                    <strong>增值稅預估（自用）</strong> 或 <strong>增值稅預估（一般）</strong> 尚未填入：
                </p>
                <div style="background:#fafafa;border:1px solid #f0f0f0;border-radius:8px;padding:12px;margin-bottom:20px;max-height:100px;overflow-y:auto;">
                    ${landList}${moreText}
                </div>
                <p style="color:#888;font-size:12px;line-height:1.6;margin-bottom:20px;">
                    💡 若前次移轉早於民國70年，請至編輯視窗手動填入消費者物價總指數後計算。
                </p>
                <!-- 今日不再顯示 -->
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:20px;">
                    <input type="checkbox" id="taxWarningSuppressToday" style="width:16px;height:16px;accent-color:#7d2ae8;cursor:pointer;">
                    <span style="font-size:13px;color:#555;">今日不再顯示此警告</span>
                </label>
                <!-- Buttons -->
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button onclick="closeTaxWarning()" style="padding:10px 20px;border:1px solid #ddd;background:white;color:#555;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='white'">取消</button>
                    <button onclick="ignoreTaxWarning()" style="padding:10px 24px;background:linear-gradient(135deg,#7d2ae8,#00c4cc);color:white;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(125,42,232,0.3);transition:all 0.2s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">忽略並匯出</button>
                </div>
            </div>
        </div>
    `;

    // 儲存 callback 供忽略按鈕使用
    overlay._onIgnore = onIgnore;
    document.body.appendChild(overlay);
}

function closeTaxWarning() {
    const overlay = document.getElementById('taxWarningOverlay');
    if (overlay) overlay.remove();
}

function ignoreTaxWarning() {
    const overlay = document.getElementById('taxWarningOverlay');
    const suppress = document.getElementById('taxWarningSuppressToday')?.checked;
    if (suppress) {
        const todayKey = 'taxWarningSuppressed_' + new Date().toISOString().slice(0, 10);
        localStorage.setItem(todayKey, '1');
    }
    const cb = overlay?._onIgnore;
    overlay?.remove();
    if (typeof cb === 'function') cb();
}

function updateGlobalSummary() {
    let tArea=0, tVal=0;
    for (let id in data) {
        let l = data[id];
        let area = l['土地面積']['面積'] || 0;
        let val  = l['當期公告現值'] || 0;
        let s    = Array.isArray(l['土地面積']['權利範圍']) ? l['土地面積']['權利範圍'].reduce((a,b)=>a+b,0) : (l['土地面積']['權利範圍']||0);
        tArea += area * s; tVal += val * s; 
    }
    document.getElementById('sumHeldArea').innerText = tArea.toFixed(2);
    document.getElementById('sumHeldPing').innerText = (tArea * PING_FACTOR).toFixed(2);
    document.getElementById('sumAssessedValue').innerText = '$' + Math.round(tVal).toLocaleString();
}

// ══════════════════════════════════════════════════════════════
// 截圖縮圖
// ══════════════════════════════════════════════════════════════

async function captureThumbnail() {
    const gridB = document.getElementById('gridB');
    if (!gridB || currentProjectIndex === -1) return;
    try {
        const canvas = await html2canvas(gridB, { scale: 1, useCORS: true, logging: false, backgroundColor: '#ebecf0' });
        const thumbCanvas = document.createElement('canvas');
        const ctx = thumbCanvas.getContext('2d');
        const targetWidth = 400;
        const scale = targetWidth / canvas.width;
        thumbCanvas.width = targetWidth;
        thumbCanvas.height = canvas.height * scale;
        ctx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
        const projects = JSON.parse(localStorage.getItem('brick_projects') || '[]');
        if(projects[currentProjectIndex]) {
            projects[currentProjectIndex].thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.5);
            localStorage.setItem('brick_projects', JSON.stringify(projects));
        }
    } catch (err) { console.error('背景截圖失敗:', err); }
}

// ══════════════════════════════════════════════════════════════
// 匯出面板
// ══════════════════════════════════════════════════════════════

function openExportModal() {
    const modal = document.getElementById('exportModal');
    const colGrid = document.getElementById('columnToggleGrid');
    
    const columns = {
        "地段小段": "地段", "所有權人": "所有權人", "土地面積_m²": "土地面積_m²", "土地面積_坪": "土地面積_坪",
        "權利範圍(土地)": "土地面積_權利範圍", "土地持分(坪)": "土地面積_土地持分面積(坪)", "總土地比率": "土地面積_總土地比率",
        "他項權利": "他項權利", "前次現值": "前次取得_公告現值", "前次年月": "前次取得_年月", "當期現值": "當期公告現值",
        "增值稅(自)": "增值稅預估(自用)", "增值稅(般)": "增值稅預估(一般)", "建物門牌": "建物門牌", "建物持分(坪)": "持分面積_坪",
        "所有權地址": "所有權地址", "電話": "電話"
    };

    colGrid.innerHTML = '';
    for(let name in columns) {
        colGrid.innerHTML += `<label style="display:flex;gap:5px;cursor:pointer;"><input type="checkbox" checked class="col-toggle" data-key="${columns[name]}"> ${name}</label>`;
    }

    const filterValSelect = document.getElementById('exportFilterValue');
    filterValSelect.innerHTML = '';
    modal.style.display = 'flex';
}

function closeExportModal() {
    document.getElementById('exportModal').style.display = 'none';
}

function toggleExportFilterUI() {
    const type = document.getElementById('exportFilterType').value;
    const wrap  = document.getElementById('exportFilterValueWrap');
    const label = document.getElementById('exportFilterLabel');
    const select = document.getElementById('exportFilterValue');
    
    if (type === 'all') { wrap.style.display = 'none'; return; }
    
    wrap.style.display = 'block';
    select.innerHTML = '';
    
    if (type === 'land') {
        label.innerText = '請選擇地號';
        Object.keys(data).forEach(id => { select.innerHTML += `<option value="${id}">${id}</option>`; });
    } else {
        label.innerText = '請選擇所有權人';
        const owners = new Set();
        for(let id in data) data[id]["所有權人"].forEach(o => owners.add(o));
        owners.forEach(o => { select.innerHTML += `<option value="${o}">${o}</option>`; });
    }
}

function startAdvancedExport() {
    const selectedSheets = Array.from(document.querySelectorAll('#sheetSelectGrid input:checked')).map(el => el.value);
    const hiddenCols = Array.from(document.querySelectorAll('.col-toggle:not(:checked)')).map(el => el.getAttribute('data-key'));
    const filterConfig = {
        type: document.getElementById('exportFilterType').value,
        value: document.getElementById('exportFilterValue').value
    };
    const isPureValue = document.getElementById('exportPureValue').checked;
    if (selectedSheets.length === 0) return alert("請至少選擇一個要輸出的工作表");

    // 檢查是否有缺少增值稅的地號
    const missingLands = Object.keys(data).filter(id => checkLandMissingTax(id));
    const todayKey = 'taxWarningSuppressed_' + new Date().toISOString().slice(0, 10);
    const suppressed = localStorage.getItem(todayKey) === '1';

    if (missingLands.length > 0 && !suppressed) {
        // 關掉匯出 modal，顯示增值稅警告
        closeExportModal();
        showMissingTaxWarning(missingLands, () => {
            // 使用者選擇忽略，繼續匯出
            exportFancyExcelAdvanced({ isPureValue, selectedSheets, hiddenCols, filterConfig });
        });
        return;
    }

    exportFancyExcelAdvanced({ isPureValue, selectedSheets, hiddenCols, filterConfig });
    closeExportModal();
}