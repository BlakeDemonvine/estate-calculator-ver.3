/**
* 進階 Excel 匯出功能
* @param {Object} config - 包含 isPureValue, selectedSheets, hiddenCols, filterConfig
*/
// 取得精確分數值（直接用分子/分母，避免浮點誤差）
function getExactScope(landData, field, idx) {
    const numArr = field === 'land'
        ? (landData['土地面積'] && landData['土地面積']['權利範圍_num'])
        : landData['權利範圍_num'];
    const denArr = field === 'land'
        ? (landData['土地面積'] && landData['土地面積']['權利範圍_den'])
        : landData['權利範圍_den'];
    if (numArr && denArr && numArr[idx] !== undefined) {
        const n = numArr[idx], d = denArr[idx] || 1;
        return n / d; // exact rational as float
    }
    // fallback: use existing decimal
    const arr = field === 'land'
        ? (landData['土地面積'] && landData['土地面積']['權利範圍'])
        : landData['權利範圍'];
    return Array.isArray(arr) ? (arr[idx] || 0) : (arr || 0);
}

// 取得建物權利範圍的精確分子與分母
function getBuildScopeFraction(landData, idx) {
    const numArr = landData['權利範圍_num'];
    const denArr = landData['權利範圍_den'];
    if (numArr && denArr && numArr[idx] !== undefined) {
        return { num: numArr[idx], den: denArr[idx] || 1 };
    }
    // fallback: convert decimal to fraction
    const arr = landData['權利範圍'];
    const dec = Array.isArray(arr) ? (arr[idx] || 0) : (arr || 0);
    if (!dec) return { num: 0, den: 1 };
    if (dec === 1) return { num: 1, den: 1 };
    // find fraction via continued fraction approximation
    const precision = 1000000;
    let num = Math.round(dec * precision);
    let den = precision;
    function gcdF(a, b) { a=Math.abs(a); b=Math.abs(b); while(b){let t=b;b=a%b;a=t;} return a; }
    const g = gcdF(num, den);
    return { num: num/g, den: den/g };
}

async function exportFancyExcelAdvanced(config) {
    const { isPureValue, selectedSheets, hiddenCols, filterConfig } = config;
    const workbook = new ExcelJS.Workbook();
    const alphabet = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB'];
    
    // -------------------------------------------------------
    // 1. 數據過濾邏輯 (Data Filtering)
    // -------------------------------------------------------
    let exportData = {};
    if (filterConfig.type === 'all') {
        exportData = JSON.parse(JSON.stringify(data)); // 使用全域 data
    } else if (filterConfig.type === 'land') {
        const landId = filterConfig.value;
        if (data[landId]) {
            exportData[landId] = JSON.parse(JSON.stringify(data[landId]));
        }
    } else if (filterConfig.type === 'owner') {
        const targetOwner = filterConfig.value;
        for (let landId in data) {
            const original = data[landId];
            const indices = [];
            
            original["所有權人"].forEach((name, idx) => {
                if (name === targetOwner) indices.push(idx);
            });

            if (indices.length > 0) {
                const filteredLand = JSON.parse(JSON.stringify(original));
                const arrayKeys = [
                    "所有權人", "年月", "公告現值", "增值稅預估(自用)", "增值稅預估(一般)", 
                    "建號", "建物門牌", "樓層", "建物面積", "附屬建物用途", "附屬建物面積", "權利範圍", "所有權地址", 
                    "增值稅試算(自用)", "增值稅試算(一般)"
                ];
                arrayKeys.forEach(k => {
                    filteredLand[k] = indices.map(i => original[k][i]);
                });
                filteredLand["土地面積"]["權利範圍"] = indices.map(i => original["土地面積"]["權利範圍"][i]);
                exportData[landId] = filteredLand;
            }
        }
    }

    // 計算過濾後的總面積
    let total = 0;
    for(let k in exportData){
        total += exportData[k]['土地面積']['面積'];
    }

    // ★ 特別注意：由於「地主可分配面積(D)」的公式高度依賴「清冊(A)」，
    // 無論使用者有沒有勾選輸出「清冊」，我們都必須產生 sheetA，若未勾選則將其隱藏。
    const sheetA = workbook.addWorksheet('清冊');
    if (!selectedSheets.includes('清冊')) {
        sheetA.state = 'hidden';
    }

    // -------------------------------------------------------
    // 1. Sheet A: 清冊
    // -------------------------------------------------------
    function goA() {
        sheetA.columns = [
            { key: '地段', width: 10 },
            { key: '小段', width: 10 },
            { key: '地號', width: 10 },
            { key: '所有權人', width: 15 },
            { key: '土地面積_m²', width: 12 , style: { numFmt: '0.00' }},
            { key: '土地面積_坪', width: 12 , style: { numFmt: '0.00' }},
            { key: '土地面積_權利範圍', width: 12 , style: { numFmt: '# ????????/????????' }},
            { key: '土地面積_土地持分面積(m²)', width: 19 , style: { numFmt: '0.00' }},
            { key: '土地面積_土地持分面積(坪)', width: 19 , style: { numFmt: '0.00' }},
            { key: '土地面積_總土地比率', width: 13, style: { numFmt: '0.00%' }},
            { key: '他項權利', width: 15 },
            { key: '前次取得_公告現值', width: 15 , style: { numFmt: '#,##0.00' }},
            { key: '前次取得_年月', width: 12 },
            { key: '當期公告現值', width: 22  , style: { numFmt: '#,##0.00' }},
            { key: '增值稅預估(自用)', width: 18 , style: { numFmt: '#,##0.00' }},
            { key: '增值稅預估(一般)', width: 18 , style: { numFmt: '#,##0.00' }},
            { key: '建號', width: 10 },
            { key: '建物門牌', width: 25 },
            { key: '樓層', width: 10 },
            { key: '建物面積_m²', width: 12 , style: { numFmt: '0.00' }},
            { key: '建物面積_坪', width: 12 , style: { numFmt: '0.00' }},
            { key: '權利範圍', width: 12 , style: { numFmt: '# ????????/????????' }},
            { key: '持分面積_m²', width: 12 , style: { numFmt: '0.00' }},
            { key: '持分面積_坪', width: 12 , style: { numFmt: '0.00' }},
            { key: '所有權地址', width: 30 },
            { key: '電話', width: 15 },
            { key: '增值稅試算_一般', width: 15 , style: { numFmt: '#,##0.00' }},
            { key: '增值稅試算_自用', width: 15 , style: { numFmt: '#,##0.00' }},
        ];

        // 隱藏使用者選擇不輸出的欄位
        sheetA.columns.forEach(col => {
            if (hiddenCols && hiddenCols.includes(col.key)) {
                col.hidden = true;
            }
        });

        if (sheetA.columnCount > 29) {
            sheetA.spliceColumns(30, sheetA.columnCount - 29);
        }
        sheetA.addRow([`${basics['地段']}土地清冊`]);
        let sheetArow2 = ['地段','小段','地號','所有權人','土地面積','','','','','','他項權利','前次取得','','當期公告現值','增值稅預估(自用)','增值稅預估(一般)','建號','建物門牌','樓層','建物面積','','權利範圍','持分面積','','所有權地址','電話','增值稅試算',''];
        let sheetArow3 = ['','','','','m²','坪','權利範圍','土地持分面積(m²)','土地持分面積(坪)','總土地比率','','公告現值','年月','','','','','','','m²','坪','','m²','坪','','','一般','自用'];
        sheetA.addRow(sheetArow2);
        sheetA.addRow(sheetArow3);
        sheetA.mergeCells('A1:AB1');
        
        let first = 0;
        for(let i = 0 ; i<28 ; i++){
            if(sheetArow3[i] === ''){
                sheetA.mergeCells(`${alphabet[i]}2:${alphabet[i]}3`);
            }
            if(sheetArow2[i] === '' && first === 0){
                first = i-1;
            }
            if((sheetArow2[i] !== '' || i===27) && first!==0){
                if(i===27){
                    sheetA.mergeCells(`${alphabet[first]}2:AB2`);
                }
                else{
                    sheetA.mergeCells(`${alphabet[first]}2:${alphabet[i-1]}2`);
                }
                first = 0;
            }

            [`${alphabet[i]}2`,`${alphabet[i]}3`].forEach(cellKey => {
                const cell = sheetA.getCell(cellKey);
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd6e3bc' } };
                cell.border = { top: { style: 'thin', color: { argb: 'FF000000' } }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                cell.font = { bold: true };
                cell.alignment = { vertical: 'middle', horizontal: 'center' };
            });
        }

        for(let num in exportData){
            let temp = [];
            const area = exportData[num]['土地面積']['面積'];
            for(let i = 0 ; i<exportData[num]['所有權人'].length ; i++){
                const ratio = getExactScope(exportData[num], 'land', i);
                if(isPureValue){
                    temp.push(['','','',exportData[num]['所有權人'][i],'','',ratio,area*ratio,area*ratio*0.3025,area*ratio/total,'',exportData[num]['公告現值'][i],exportData[num]['年月'][i],'',exportData[num]['增值稅預估(自用)'][i],exportData[num]['增值稅預估(一般)'][i],exportData[num]['建號'][i],exportData[num]['建物門牌'][i],exportData[num]['樓層'][i],exportData[num]['建物面積'][i],exportData[num]['建物面積'][i]*0.3025,getExactScope(exportData[num], 'build', i),exportData[num]['建物面積'][i]*getExactScope(exportData[num], 'build', i),exportData[num]['建物面積'][i]*getExactScope(exportData[num], 'build', i)*0.3025,exportData[num]['所有權地址'][i],'',exportData[num]['增值稅試算(自用)'][i],exportData[num]['增值稅試算(一般)'][i]]);
                }
                else{
                    temp.push(['','','',exportData[num]['所有權人'][i],'','',ratio,{formula:`E${sheetA.rowCount+1}*G${sheetA.rowCount+1+i}`},{formula:`H${sheetA.rowCount+1+i}*0.3025`},{formula:`H${sheetA.rowCount+1+i}/SUM(H4:H9999)*2`},'',exportData[num]['公告現值'][i],exportData[num]['年月'][i],'',exportData[num]['增值稅預估(自用)'][i],exportData[num]['增值稅預估(一般)'][i],exportData[num]['建號'][i],exportData[num]['建物門牌'][i],exportData[num]['樓層'][i],exportData[num]['建物面積'][i],{formula:`T${sheetA.rowCount+1+i}*0.3025`},getExactScope(exportData[num], 'build', i),{formula:`T${sheetA.rowCount+1+i}*V${sheetA.rowCount+1+i}`},{formula:`W${sheetA.rowCount+1+i}*0.3025`},exportData[num]['所有權地址'][i],'',exportData[num]['增值稅試算(自用)'][i],exportData[num]['增值稅試算(一般)'][i]]);
                }
            }
            temp[0][2] = num;
            temp[0][4] = area;
            if(isPureValue){
                temp[0][5] = area*0.3025;
            }
            else{
                temp[0][5] = { formula: `E${sheetA.rowCount+1}*0.3025` };
            }
            
            temp[0][10] = exportData[num]['他項權利'];
            temp[0][13] = exportData[num]['當期公告現值'];
            temp[0][25] = exportData[num]['電話'];

            let last = sheetA.rowCount+1;
            for(let k of temp){
                sheetA.addRow(k);
            }

            ['C','E','F','K','N','Z'].forEach(key => {
                sheetA.mergeCells(`${key}${last}:${key}${sheetA.rowCount}`);
            });

            ['L','M'].forEach(key => {
                mergeCheck(sheetA,key,last,sheetA.rowCount);
            });
        }
        
        ['D','Q','R','Y'].forEach(key => {
            mergeCheck(sheetA,key,4,sheetA.rowCount);
        });

        sheetA.mergeCells(`A4:A${sheetA.rowCount}`);
        
        let finalRow = ['','','','總計'];
        for(let i = 4 ; i<28 ; i++){
            finalRow.push('');
        }

        sheetA.addRow(finalRow);
        let currentRowIndex = sheetA.rowCount;
        let totalRow = sheetA.getRow(currentRowIndex);

        totalRow.eachCell({ includeEmpty: true }, (cell) => {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf2f2f2' } };
        });

        sheetA.mergeCells(`A${currentRowIndex}:C${currentRowIndex}`);
        sheetA.mergeCells(`K${currentRowIndex}:M${currentRowIndex}`);
        sheetA.mergeCells(`O${currentRowIndex}:AB${currentRowIndex}`);

        ['E','F','H','I','J','N'].forEach(key => {
            const dataEndRow = currentRowIndex - 1; 
            if(isPureValue){
                let ans = 0;
                for(let j = 4 ; j<=dataEndRow ; j++){
                    ans += parseFloat(sheetA.getCell(`${key}${j}`).value) || 0;
                }
                sheetA.getCell(`${key}${currentRowIndex}`).value = ans;
            }
            else{
                sheetA.getCell(`${key}${currentRowIndex}`).value = {
                    formula: `SUM(${key}4:${key}${dataEndRow})`
                };
            }
        });
        
        for (let i = 1; i <= 28; i++) {
            const col = sheetA.getColumn(i);
            col.alignment = { 
                vertical: 'middle', 
                horizontal: col.alignment ? col.alignment.horizontal : undefined,
                wrapText: true
            };
        }
        sheetA.getCell('A4').value = basics['地段'];
    }
    goA();

    // -------------------------------------------------------
    // 2. Sheet B: 增值稅歸戶表
    // -------------------------------------------------------
    if (selectedSheets.includes('增值稅歸戶表')) {
        const sheetB = workbook.addWorksheet('增值稅歸戶表');
        function goB() {
            sheetB.columns = [
                { key: '編號', width: 8 },
                { key: '所有權人', width: 15 },
                { key: '地號', width: 10 },
                { key: '面積(坪)', width: 12 , style: { numFmt: '0.00' }},
                { key: '權利範圍', width: 12 , style: { numFmt: '# ????????/????????' }},
                { key: '各持分面積(坪)', width: 16 , style: { numFmt: '0.00' }},
                { key: '前次取得-年月', width: 12 },
                { key: '前次取得-公告現值', width: 15 , style: { numFmt: '#,##0.00' }},
                { key: '當期公告現值', width: 22 , style: { numFmt: '#,##0.00' }},
                { key: '增值稅預估(自用)', width: 19 , style: { numFmt: '#,##0.00' }},
                { key: '增值稅合計(自用)', width: 19 , style: { numFmt: '#,##0.00' }},
                { key: '增值稅預估(一般)', width: 19 , style: { numFmt: '#,##0.00' }},
                { key: '增值稅合計(一般)', width: 19 , style: { numFmt: '#,##0.00' }}
            ];

            if (sheetB.columnCount > 13) {
                sheetB.spliceColumns(14, 16384);
            }

            sheetB.addRow([`${basics['地段']}增值稅歸戶表`]);
            let sheetArow2 = ['編號','所有權人','地號','面積(坪)','權利範圍','各持分面積(坪)','前次取得','','當期公告現值','增值稅預估(自用)','增值稅合計(自用)','增值稅預估(一般)','增值稅合計(一般)'];
            let sheetArow3 = ['','','','','','','年月','公告現值','','','','',''];

            sheetB.addRow(sheetArow2);
            sheetB.addRow(sheetArow3);
            sheetB.mergeCells('A1:M1');

            let first = 0; 
            for(let i = 0 ; i<13 ; i++){
                if(sheetArow3[i] === ''){
                    sheetB.mergeCells(`${alphabet[i]}2:${alphabet[i]}3`);
                }
                if(sheetArow2[i] === '' && first === 0){
                    first = i-1;
                }
                if((sheetArow2[i] !== '' || i===12) && first!==0){ 
                    if (first < 0) first = 0; 
                    if(i===12 && sheetArow2[i] === ''){ 
                        sheetB.mergeCells(`${alphabet[first]}2:M2`);
                    }
                    else{
                        sheetB.mergeCells(`${alphabet[first]}2:${alphabet[i-1]}2`);
                    }
                    first = 0;
                }

                [`${alphabet[i]}2`,`${alphabet[i]}3`].forEach(cellKey => {
                    const cell = sheetB.getCell(cellKey);
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd6e3bc' } };
                    cell.border = { top: { style: 'thin', color: { argb: 'FF000000' } }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    cell.font = { bold: true };
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });
            }

            let names = []; 
            let temp = [];

            for(let num in exportData){
                const owners = exportData[num]['所有權人'];
                for(let i = 0; i < owners.length; i++){
                    let name = owners[i];
                    if(!names.includes(name)){
                        names.push(name);
                    }
                    let area = exportData[num]['土地面積']['面積'] * 0.3025;
                    let ratio = getExactScope(exportData[num], 'land', i); 
                    
                    temp.push([
                        names.indexOf(name) + 1, 
                        name,                    
                        num,                     
                        area,                    
                        ratio,                   
                        area*ratio, 
                        exportData[num]['年月'][i],
                        exportData[num]['公告現值'][i],
                        exportData[num]['當期公告現值'],
                        exportData[num]['增值稅預估(自用)'][i],
                        '', 
                        exportData[num]['增值稅預估(一般)'][i],
                        ''  
                    ]);
                }
            }

            temp.sort((a, b) => a[0] - b[0]);

            for(let i = 1 ; i <= names.length ; i++){
                const temp2 = temp.filter(row => row[0] === i);
                if (temp2.length === 0) continue; 

                let last = sheetB.rowCount + 1; 
                
                for(let k of temp2){
                    let currentRow = sheetB.rowCount + 1;
                    let rowData = [...k]; 
                    if(!isPureValue){
                        rowData[5] = { formula: `D${currentRow}*E${currentRow}` };
                    }
                    sheetB.addRow(rowData);
                }

                ['A','B','G','H','I','K','M'].forEach(key=>{
                    mergeCheck(sheetB,key,last,sheetB.rowCount);
                    if(key === 'K' || key === 'M'){
                        let preKey = 'Tommy';
                        if(key === 'K'){ preKey = 'J'; }
                        else if(key === 'M'){ preKey = 'L'; }
                        
                        if(isPureValue){
                            let ans = 0;
                            for(let j = last ; j<=sheetB.rowCount ; j++){
                                ans += sheetB.getCell(`${preKey}${j}`).value || 0;
                            }
                            sheetB.getCell(`${key}${last}`).value = ans;
                        }
                        else{
                            sheetB.getCell(`${key}${last}`).value = {formula:`SUM(${preKey}${last}:${preKey}${sheetB.rowCount})`};
                        }
                    }
                });
            }
            
            let finalRow = ['合計','','',''];
            for(let i = 4 ; i<13 ; i++){ finalRow.push(''); }

            sheetB.addRow(finalRow);
            let currentRowIndex = sheetB.rowCount;
            let totalRow = sheetB.getRow(currentRowIndex);

            totalRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf2f2f2' } };
            });

            sheetB.mergeCells(`A${currentRowIndex}:D${currentRowIndex}`);
            sheetB.mergeCells(`G${currentRowIndex}:I${currentRowIndex}`);

            ['F','J','K','L','M'].forEach(key => {
                const dataEndRow = currentRowIndex - 1; 
                if(isPureValue){
                    let ans = 0;
                    for(let j = 4 ; j<=dataEndRow ; j++){
                        ans += sheetB.getCell(`${key}${j}`).value || 0;
                    }
                    sheetB.getCell(`${key}${currentRowIndex}`).value = ans;
                }
                else{
                    sheetB.getCell(`${key}${currentRowIndex}`).value = {
                        formula: `SUM(${key}4:${key}${dataEndRow})`
                    };
                }
            });

            for (let i = 1; i <= 13; i++) {
                const col = sheetB.getColumn(i);
                col.alignment = { 
                    vertical: 'middle', 
                    horizontal: col.alignment ? col.alignment.horizontal : undefined,
                    wrapText: true
                };
            }
        }
        goB();
    }

    // -------------------------------------------------------
    // 3. Sheet C: 土地歸戶表
    // -------------------------------------------------------
    if (selectedSheets.includes('土地歸戶表')) {
        const sheetC = workbook.addWorksheet('土地歸戶表');
        function goC() {
            sheetC.columns = [
                {key: 'id', width: 8 }, {key: 'owner', width: 15 }, {key: 'land_no', width: 10 },
                {key: 'area_ping', width: 12 , style: { numFmt: '0.000' }}, {key: 'scope', width: 12 , style: { numFmt: '# ????????/????????' }},
                {key: 'shared_area_ping', width: 18 , style: { numFmt: '0.000' }}, {key: 'total_shared_area_ping', width: 18 , style: { numFmt: '0.000' }},
                {key: 'total_legal_far', width: 18 , style: { numFmt: '0.000' }},
                {key: 'owner_legal_far', width: 18 , style: { numFmt: '0.000' }},
                {key: 'total_bonus_far', width: 20 , style: { numFmt: '0.000' }},
                {key: 'owner_bonus_far', width: 20 , style: { numFmt: '0.000' }},
                {key: 'total_disaster_far', width: 20 , style: { numFmt: '0.000' }},
                {key: 'owner_disaster_far', width: 20 , style: { numFmt: '0.000' }},
                {key: 'with_disaster', width: 18 , style: { numFmt: '0.000' }},
                {key: 'without_disaster', width: 18 , style: { numFmt: '0.000' }},
            ];

            if (sheetC.columnCount > 15) {
                sheetC.spliceColumns(16, sheetC.columnCount - 15);
            }

            const tbl = basics['土地歸戶表'] || {};
            const legalFar   = tbl['合計法定容積']       ?? 2.25;
            const legalOR    = tbl['地主法定容積佔比']   ?? 0.58;
            const bonusFar   = tbl['都更獎勵容積']        ?? 0.5;
            const bonusOR    = tbl['地主獎勵容積佔比']   ?? 0.5;
            const disastFar  = tbl['防災都更獎勵容積']   ?? 0.3;
            const disastOR   = tbl['地主防災都更佔比']   ?? 0.5;
            const jRatio     = tbl['合建分取']            ?? 1.58;

            sheetC.addRow([`${basics['地段']}土地歸戶表`]);
            let row2 = ['編號','所有權人','地號','面積(坪)','權利範圍','各持分面積(坪)','總持分面積(坪)','合計法定容積','地主獲得的法定容積','合計獲得的都更獎勵容積','地主獲得的都更獎勵容積','合計獲得的防災都更獎勵','地主獲得的防災都更獎勵','有防災都更獎勵','無防災都更獎勵'];
            let row3 = ['','','','','','','',legalFar, legalOR, bonusFar, bonusOR, disastFar, disastOR, jRatio, ''];
            sheetC.addRow(row2);
            sheetC.addRow(row3);
            sheetC.mergeCells('A1:O1');
            // Format row3 params
            ['H','I','J','K','L','M','N'].forEach(col => {
                sheetC.getCell(`${col}3`).numFmt = '0.00';
            });

            const extAlphabet = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O'];
            let first = 0;
            for(let i = 0; i < 15; i++){
                if(row3[i] === ''){
                    try { sheetC.mergeCells(`${extAlphabet[i]}2:${extAlphabet[i]}3`); } catch(e){}
                }
                if(row2[i] === '' && first === 0){
                    first = i-1;
                }
                if((row2[i] !== '' || i===14) && first!==0){
                    if (first < 0) first = 0;
                    if(i===14 && row2[i] === ''){
                        try { sheetC.mergeCells(`${extAlphabet[first]}2:O2`); } catch(e){}
                    } else {
                        try { sheetC.mergeCells(`${extAlphabet[first]}2:${extAlphabet[i-1]}2`); } catch(e){}
                    }
                    first = 0;
                }

                [`${extAlphabet[i]}2`,`${extAlphabet[i]}3`].forEach(cellKey => {
                    const cell = sheetC.getCell(cellKey);
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd6e3bc' } };
                    cell.border = { top: { style: 'thin', color: { argb: 'FF000000' } }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    cell.font = { bold: true };
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });
            }

            let names = [];
            let temp = [];

            for(let num in exportData){
                const owners = exportData[num]['所有權人'];
                for(let i = 0; i < owners.length; i++){
                    let name = owners[i];
                    if(!names.includes(name)) names.push(name);
                    let area = parseFloat((exportData[num]['土地面積']['面積'] * 0.3025).toFixed(3));
                    let ratio = getExactScope(exportData[num], 'land', i);
                    let sharedPing = parseFloat((area * ratio).toFixed(3));

                    temp.push([
                        names.indexOf(name) + 1,
                        name,
                        num,
                        area,
                        ratio,
                        sharedPing,
                        0, // G = SUM(F) per person — filled later
                        0, // H
                        0, // I
                        0, // J
                        0, // K
                        0, // L
                        0, // M
                        0, // N
                        0, // O
                    ]);
                }
            }

            temp.sort((a, b) => a[0] - b[0]);

            for(let i = 1; i <= names.length; i++){
                const temp2 = temp.filter(row => row[0] === i);
                if (temp2.length === 0) continue;

                let last = sheetC.rowCount + 1;
                for(let k of temp2){
                    let currentRow = sheetC.rowCount + 1;
                    let rowData = [...k];
                    if(!isPureValue){
                        rowData[5] = { formula: `D${currentRow}*E${currentRow}` };
                    }
                    sheetC.addRow(rowData);
                }

                // G: 總持分面積 = SUM(F for this person)
                sheetC.mergeCells(`A${last}:A${sheetC.rowCount}`);
                sheetC.mergeCells(`B${last}:B${sheetC.rowCount}`);
                sheetC.mergeCells(`G${last}:G${sheetC.rowCount}`);
                sheetC.mergeCells(`H${last}:H${sheetC.rowCount}`);
                sheetC.mergeCells(`I${last}:I${sheetC.rowCount}`);
                sheetC.mergeCells(`J${last}:J${sheetC.rowCount}`);
                sheetC.mergeCells(`K${last}:K${sheetC.rowCount}`);
                sheetC.mergeCells(`L${last}:L${sheetC.rowCount}`);
                sheetC.mergeCells(`M${last}:M${sheetC.rowCount}`);
                sheetC.mergeCells(`N${last}:N${sheetC.rowCount}`);
                sheetC.mergeCells(`O${last}:O${sheetC.rowCount}`);

                if(isPureValue){
                    let sumF = 0;
                    for(let j = last; j <= sheetC.rowCount; j++){
                        sumF += parseFloat(sheetC.getCell(`F${j}`).value) || 0;
                    }
                    sumF = parseFloat(sumF.toFixed(3));
                    sheetC.getCell(`G${last}`).value = sumF;
                    sheetC.getCell(`H${last}`).value = parseFloat((sumF * legalFar).toFixed(3));
                    sheetC.getCell(`I${last}`).value = parseFloat((sumF * legalFar * legalOR).toFixed(3));
                    sheetC.getCell(`J${last}`).value = parseFloat((sumF * legalFar * bonusFar).toFixed(3));
                    sheetC.getCell(`K${last}`).value = parseFloat((sumF * legalFar * bonusFar * bonusOR).toFixed(3));
                    sheetC.getCell(`L${last}`).value = parseFloat((sumF * legalFar * disastFar).toFixed(3));
                    sheetC.getCell(`M${last}`).value = parseFloat((sheetC.getCell(`L${last}`).value * disastOR).toFixed(3));
                    sheetC.getCell(`N${last}`).value = parseFloat(((sheetC.getCell(`I${last}`).value + sheetC.getCell(`K${last}`).value + sheetC.getCell(`M${last}`).value) * jRatio).toFixed(3));
                    sheetC.getCell(`O${last}`).value = parseFloat(((sheetC.getCell(`I${last}`).value + sheetC.getCell(`K${last}`).value) * jRatio).toFixed(3));
                } else {
                    sheetC.getCell(`G${last}`).value = {formula: `SUM(F${last}:F${sheetC.rowCount})`};
                    sheetC.getCell(`H${last}`).value = {formula: `G${last}*H$3`};
                    sheetC.getCell(`I${last}`).value = {formula: `G${last}*H$3*I$3`};
                    sheetC.getCell(`J${last}`).value = {formula: `G${last}*H$3*J$3`};
                    sheetC.getCell(`K${last}`).value = {formula: `G${last}*H$3*J$3*K$3`};
                    sheetC.getCell(`L${last}`).value = {formula: `G${last}*H$3*L$3`};
                    sheetC.getCell(`M${last}`).value = {formula: `L${last}*M$3`};
                    sheetC.getCell(`N${last}`).value = {formula: `(I${last}+K${last}+M${last})*N$3`};
                    sheetC.getCell(`O${last}`).value = {formula: `(I${last}+K${last})*N$3`};
                }
            }

            let finalRow = ['合計'];
            for(let i = 1; i < 15; i++){ finalRow.push(''); }

            sheetC.addRow(finalRow);
            let currentRowIndex = sheetC.rowCount;
            let totalRow = sheetC.getRow(currentRowIndex);

            totalRow.eachCell({ includeEmpty: true }, (cell) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf2f2f2' } };
            });

            sheetC.mergeCells(`A${currentRowIndex}:E${currentRowIndex}`);

            ['F','G','H','I','J','K','L','M','N','O'].forEach(key => {
                const dataEndRow = currentRowIndex - 1;
                if(isPureValue){
                    let ans = 0;
                    for(let j = 4; j<=dataEndRow; j++){
                        ans += parseFloat(sheetC.getCell(`${key}${j}`).value) || 0;
                    }
                    sheetC.getCell(`${key}${currentRowIndex}`).value = parseFloat(ans.toFixed(3));
                } else {
                    sheetC.getCell(`${key}${currentRowIndex}`).value = {
                        formula: `SUM(${key}4:${key}${dataEndRow})`
                    };
                }
                sheetC.getCell(`${key}${currentRowIndex}`).numFmt = '0.000';
            });

            for (let i = 1; i <= 15; i++) {
                const col = sheetC.getColumn(i);
                col.alignment = {
                    vertical: 'middle',
                    horizontal: col.alignment ? col.alignment.horizontal : undefined,
                    wrapText: true
                };
            }
        }
        goC();
    }

    // -------------------------------------------------------
    // 4. Sheet D: 地主可分配面積
    // -------------------------------------------------------
    if (selectedSheets.includes('地主可分配面積')) {
        const sheetD = workbook.addWorksheet('地主可分配面積');
        function goD() {
            sheetD.columns = [
                {key: 'section', width: 10 }, {key: 'subsection', width: 10 }, {key: 'land_no', width: 10 }, {key: 'owner', width: 15 },
                {key: 'area_m2', width: 10 , style: { numFmt: '0.00' }}, {key: 'area_ping', width: 10 , style: { numFmt: '0.00' }},
                {key: 'scope', width: 10 , style: { numFmt: '# ????????/????????' }}, {key: 'shared_area_m2', width: 17 , style: { numFmt: '0.00' }},
                {key: 'shared_area_ping', width: 17 , style: { numFmt: '0.00' }}, {key: 'total_ratio', width: 12 , style: { numFmt: '0.00%' }},
                {key: 'zoning', width: 10 }, {key: 'base_far', width: 12 , style: { numFmt: '0%' }}, {key: 'coverage', width: 10 , style: { numFmt: '0%' }},
                {key: 'base_far_area', width: 17 , style: { numFmt: '0.00' }}, {key: 'est_bonus_area', width: 10 , style: { numFmt: '0.00' }},
                {key: 'allowed_total_area', width: 10 , style: { numFmt: '0.00' }}, {key: 'joint_base_alloc', width: 10 , style: { numFmt: '0.00' }},
                {key: 'joint_bonus_alloc', width: 10 , style: { numFmt: '0.00' }}, {key: 'est_total_alloc', width: 12 , style: { numFmt: '0.00' }},
                {key: 'est_property_area_ping', width: 12 , style: { numFmt: '0.00%' }}, {key: 'est_parking', width: 10 , style: { numFmt: '0.00' }},
                {key: 'build_no', width: 10 , style: { numFmt: '0.00' }}, {key: 'build_owner', width: 10 , style: { numFmt: '0.00' }},
                {key: 'address', width: 10 , style: { numFmt: '0.00' }}, {key: 'orig_main_m2', width: 10 , style: { numFmt: '0.00' }},
                {key: 'orig_main_ping', width: 10 , style: { numFmt: '0.00' }}, {key: 'orig_sub_m2', width: 17 , style: { numFmt: '0.00' }},
                {key: 'orig_sub_ping', width: 15 }, {key: 'build_scope', width: 10 }, {key: 'orig_total_m2', width: 15 },
                {key: 'orig_total_ping', width: 15 }, {key: 'orig_total_ratio', width: 18 }, {key: 'orig_indoor_ping', width: 18 },
                {key: 'post_alloc_area', width: 20 }, {key: 'post_main_area', width: 18 }, {key: 'post_public_area', width: 10 },
                {key: 'diff_total', width: 18 }, {key: 'diff_main', width: 18 }, {key: 'floor1_exchange', width: 20 },
                {key: 'diff_floor1', width: 20 }, {key: 'owner_address1', width: 30 }, {key: 'owner_address2', width: 30 },
                {key: 'owner_address3', width: 30 }, {key: 'owner_address4', width: 30 }, {key: 'owner_address5', width: 30 },
                {key: 'owner_address6', width: 30 }, {key: 'owner_address7', width: 30 }, {key: 'owner_address8', width: 30 },
            ];

            if (sheetD.columnCount > 48) {
                sheetD.spliceColumns(49, sheetD.columnCount - 48);
            }
            sheetD.addRow([`${basics['地段']}土地清冊`]);
            let sheetArow2 = ['地段','小段','地號','所有權人','土地面積','','','','','','使用分區','基準容積率','建蔽率','基準容積面積(m²)','預估獎勵容積(m²)','','','','允建總容積(m²)','','合建基準容積分取','','合建獎勵容積分取','','預估分取總允建容積','','預估產權面積(坪)','預估車位數','建號','所有權人','門牌','原主建物面積(m²)','原主建物面積(坪)','附屬建物面積(m²)','附屬建物面積(坪)','持分','原建物總面積(m²)','原建物總面積(坪)','原建物總面積比例','原室內面積概算(坪)','合建分配後預估產權面積(坪)','預估分配主建物面積(坪)','預估分配公設面積(坪)','都更前後建物總產權差異(坪)','主建物差異(坪)','1樓換取2樓以上可分面積','1樓建物總產權差異(坪)','所有權人地址'];
            let sheetArow3 = ['','','','','m²','坪','權利範圍','土地持分面積(m²)','土地持分面積(坪)','總土地比率','','','','',basics['地主可分配面積']['預估獎勵容積(m²)'][0],basics['地主可分配面積']['預估獎勵容積(m²)'][1],basics['地主可分配面積']['預估獎勵容積(m²)'][2],basics['地主可分配面積']['預估獎勵容積(m²)'][3],'容積(m²)','總比率(%)',basics['地主可分配面積']['合建基準容積分取'][0],basics['地主可分配面積']['合建基準容積分取'][1],basics['地主可分配面積']['合建獎勵容積分取'][0],basics['地主可分配面積']['合建獎勵容積分取'][1],'m²','坪',basics['地主可分配面積']['預估產權面積(坪)'],basics['地主可分配面積']['預估車位數'],'','','','','','','','','','','','','','','','','','','',''];
            sheetD.addRow(sheetArow2);
            sheetD.addRow(sheetArow3);
            sheetD.mergeCells('A1:AV1'); 

            let mergeStart = -1; 
            for (let i = 0; i < 48; i++) {
                const letter = sheetD.getColumn(i + 1).letter;
                const currentKey = `${letter}2`;
                const nextKey = `${letter}3`;

                if (sheetArow2[i] !== '' && sheetArow3[i] === '' && mergeStart === -1) {
                    sheetD.mergeCells(`${currentKey}:${nextKey}`);
                }
                if (sheetArow2[i] === '') {
                    if (mergeStart === -1) { mergeStart = i - 1; }
                    if (i === 47 && mergeStart !== -1) {
                        const startLetter = sheetD.getColumn(mergeStart + 1).letter;
                        sheetD.mergeCells(`${startLetter}2:${letter}2`);
                        mergeStart = -1;
                    }
                } else {
                    if (mergeStart !== -1) {
                        const startLetter = sheetD.getColumn(mergeStart + 1).letter;
                        const endLetter = sheetD.getColumn(i).letter; 
                        sheetD.mergeCells(`${startLetter}2:${endLetter}2`);
                        mergeStart = -1; 
                    }
                }

                [currentKey, nextKey].forEach(cellKey => {
                    const cell = sheetD.getCell(cellKey);
                    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFd6e3bc' } };
                    cell.border = { top: { style: 'thin', color: { argb: 'FF000000' } }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
                    cell.font = { bold: true };
                    cell.alignment = { vertical: 'middle', horizontal: 'center' };
                });
            }
            
            const lastRow = sheetA.rowCount;

            for (let r = 4; r <= lastRow-1; r++) {
                for (let c = 1; c <= 10; c++) {
                    const cellAddress = sheetA.getCell(r, c).address;
                    if(isPureValue){
                        sheetD.getCell(r, c).value = sheetA.getCell(r, c).value;
                    }
                    else{
                        sheetD.getCell(r, c).value = {
                            formula: `IF('清冊'!${cellAddress}="","", '清冊'!${cellAddress})`
                        };
                    }
                    sheetD.getCell(r, c).style = sheetA.getCell(r, c).style;
                }
            }

            if (sheetA.model.merges) {
                sheetA.model.merges.forEach(range => {
                    const [startCell, endCell] = range.split(':');
                    const startRow = sheetA.getCell(startCell).row;
                    const endCol = sheetA.getCell(endCell).col;
                    if (startRow >= 4 && endCol <= 10) {
                        try { sheetD.mergeCells(range); } catch (e) { }
                    }
                });
            }

            sheetD.mergeCells('K2:K3');
            let idx = 3;
            for(let num in exportData){
                for(let i in exportData[num]["所有權人"]){
                    idx++;
                    sheetD.getCell(`K${idx}`).value = exportData[num]['使用分區'];
                    sheetD.getCell(`L${idx}`).value = exportData[num]['基準容積率'];
                    sheetD.getCell(`M${idx}`).value = exportData[num]['建蔽率'];
                }
            }

            const ratioCell = sheetD.getCell('AA3');
            ratioCell.numFmt = '0.00"倍"';
            
            for(let j = 4 ; j<=sheetD.rowCount ; j++){
                if(isPureValue){
                    sheetD.getCell(`N${j}`).value = sheetD.getCell(`H${j}`).value*sheetD.getCell(`L${j}`).value;
                    sheetD.getCell(`O${j}`).value = sheetD.getCell(`O3`).value*sheetD.getCell(`N${j}`).value;
                    sheetD.getCell(`P${j}`).value = sheetD.getCell(`P3`).value*sheetD.getCell(`N${j}`).value;
                    sheetD.getCell(`Q${j}`).value = sheetD.getCell(`Q3`).value*sheetD.getCell(`N${j}`).value;
                    sheetD.getCell(`R${j}`).value = sheetD.getCell(`R3`).value*sheetD.getCell(`N${j}`).value;
                    sheetD.getCell(`S${j}`).value = sheetD.getCell(`N${j}`).value+sheetD.getCell(`O${j}`).value+sheetD.getCell(`P${j}`).value+sheetD.getCell(`Q${j}`).value+sheetD.getCell(`R${j}`).value;
                    sheetD.getCell(`T${j}`).value = sheetD.getCell(`S${j}`).value/total;
                    sheetD.mergeCells(`U${j}:V${j}`);
                    sheetD.getCell(`U${j}`).value = sheetD.getCell(`V3`).value*sheetD.getCell(`N${j}`).value;
                    sheetD.mergeCells(`W${j}:X${j}`);
                    sheetD.getCell(`W${j}`).value = sheetD.getCell(`X3`).value*sheetD.getCell(`O${j}`).value;
                    sheetD.getCell(`Y${j}`).value = sheetD.getCell(`U${j}`).value+sheetD.getCell(`V${j}`).value;
                    sheetD.getCell(`Z${j}`).value = sheetD.getCell(`Y${j}`).value*0.3025;
                    sheetD.getCell(`AA${j}`).value = sheetD.getCell(`AA3`).value*sheetD.getCell(`Z${j}`).value;
                }
                else{
                    sheetD.getCell(`N${j}`).value = {formula: `H${j}*L${j}`};
                    sheetD.getCell(`O${j}`).value = {formula: `O3*N${j}`};
                    sheetD.getCell(`P${j}`).value = {formula: `P3*N${j}`};
                    sheetD.getCell(`Q${j}`).value = {formula: `Q3*N${j}`};
                    sheetD.getCell(`R${j}`).value = {formula: `R3*N${j}`};
                    sheetD.getCell(`S${j}`).value = {formula: `N${j}+O${j}+P${j}+Q${j}+R${j}`};
                    sheetD.getCell(`T${j}`).value = {formula: `S${j}*2/SUM(S4:S9999)`};
                    sheetD.mergeCells(`U${j}:V${j}`);
                    sheetD.getCell(`U${j}`).value = {formula: `V3*N${j}`};
                    sheetD.mergeCells(`W${j}:X${j}`);
                    sheetD.getCell(`W${j}`).value = {formula: `X3*O${j}`};
                    sheetD.getCell(`Y${j}`).value = {formula: `U${j}+V${j}`};
                    sheetD.getCell(`Z${j}`).value = {formula: `Y${j}*0.3025`};
                    sheetD.getCell(`AA${j}`).value = {formula: `AA3*Z${j}`};
                }
            }

            // ── AB 欄：預估車位數（公式） ──
            if (!isPureValue) {
                for (let j = 4; j <= sheetD.rowCount; j++) {
                    sheetD.getCell(`AB${j}`).value = {formula: `AB3*AA${j}`};
                }
            }

            // ── AC～AV 欄：建物相關資料 ──
            let dIdx = 3;
            for (let num in exportData) {
                const owners = exportData[num]['所有權人'];
                for (let i = 0; i < owners.length; i++) {
                    dIdx++;
                    const bArea    = parseFloat(exportData[num]['建物面積'][i]) || 0;
                    const bScope   = getExactScope(exportData[num], 'build', i);
                    const bMain    = bArea;          // 主建物面積（原謄本面積）
                    const bSub     = parseFloat((exportData[num]['附屬建物面積'] || [])[i]) || 0;  // 附屬建物面積
                    const bTotal   = bMain + bSub;
                    const bIndoor  = bTotal * bScope;

                    // AC 建號、AD 建物所有權人、AE 門牌
                    sheetD.getCell(`AC${dIdx}`).value = exportData[num]['建號'][i] || '';
                    sheetD.getCell(`AD${dIdx}`).value = owners[i];
                    sheetD.getCell(`AE${dIdx}`).value = exportData[num]['建物門牌'][i] || '';

                    // AF 原主建物面積(m²)、AG 原主建物面積(坪)
                    sheetD.getCell(`AF${dIdx}`).value = bMain || '';
                    if (isPureValue) {
                        sheetD.getCell(`AG${dIdx}`).value = bMain ? bMain * 0.3025 : '';
                    } else {
                        if (bMain) sheetD.getCell(`AG${dIdx}`).value = {formula: `AF${dIdx}*0.3025`};
                    }

                    // AH 附屬建物面積(m²)、AI 附屬建物面積(坪)
                    sheetD.getCell(`AH${dIdx}`).value = bSub || '';
                    if (bSub) {
                        sheetD.getCell(`AI${dIdx}`).value = isPureValue ? bSub * 0.3025 : {formula: `AH${dIdx}*0.3025`};
                    } else {
                        sheetD.getCell(`AI${dIdx}`).value = '';
                    }

                    // AJ 持分（建物權利範圍）—— 以精確分子/分母呈現
                    {
                        const frac = getBuildScopeFraction(exportData[num], i);
                        if (frac.num) {
                            sheetD.getCell(`AJ${dIdx}`).value = frac.num / frac.den;
                            sheetD.getCell(`AJ${dIdx}`).numFmt = `"${frac.num}/${frac.den}"`;
                        } else {
                            sheetD.getCell(`AJ${dIdx}`).value = '';
                        }
                    }

                    // AK 原建物總面積(m²)、AL 原建物總面積(坪)
                    if (isPureValue) {
                        sheetD.getCell(`AK${dIdx}`).value = bTotal || '';
                        sheetD.getCell(`AL${dIdx}`).value = bTotal ? bTotal * 0.3025 : '';
                    } else {
                        if (bMain || bSub) {
                            sheetD.getCell(`AK${dIdx}`).value = bSub
                                ? {formula: `AF${dIdx}+AH${dIdx}`}
                                : {formula: `AF${dIdx}`};
                            sheetD.getCell(`AL${dIdx}`).value = {formula: `AK${dIdx}*0.3025`};
                        }
                    }

                    // AM 原建物總面積比例（持分×總面積 / 整體）
                    if (bTotal && bScope) {
                        if (isPureValue) {
                            sheetD.getCell(`AM${dIdx}`).value = bIndoor;
                        } else {
                            sheetD.getCell(`AM${dIdx}`).value = {formula: `AK${dIdx}*AJ${dIdx}`};
                        }
                        sheetD.getCell(`AM${dIdx}`).numFmt = '0.00';
                    }

                    // AN 原室內面積概算(坪)
                    if (isPureValue) {
                        sheetD.getCell(`AN${dIdx}`).value = bIndoor ? bIndoor * 0.3025 : '';
                    } else {
                        if (bTotal && bScope) sheetD.getCell(`AN${dIdx}`).value = {formula: `AM${dIdx}*0.3025`};
                    }
                    sheetD.getCell(`AN${dIdx}`).numFmt = '0.00';

                    // AO 合建分配後預估產權面積(坪)：= AA（預估產權坪）
                    // 已由 AA 欄填入，AO 引用即可
                    if (isPureValue) {
                        sheetD.getCell(`AO${dIdx}`).value = sheetD.getCell(`AA${dIdx}`).value || '';
                    } else {
                        sheetD.getCell(`AO${dIdx}`).value = {formula: `AA${dIdx}`};
                    }
                    sheetD.getCell(`AO${dIdx}`).numFmt = '0.00';

                    // AP 預估分配主建物面積(坪) = AO * (主建物占室內比例, 預設 0.8)
                    // AQ 預估分配公設面積(坪) = AO - AP
                    if (isPureValue) {
                        const aoVal = (sheetD.getCell(`AA${dIdx}`).value || 0);
                        sheetD.getCell(`AP${dIdx}`).value = aoVal * 0.8;
                        sheetD.getCell(`AQ${dIdx}`).value = aoVal * 0.2;
                    } else {
                        sheetD.getCell(`AP${dIdx}`).value = {formula: `AO${dIdx}*0.8`};
                        sheetD.getCell(`AQ${dIdx}`).value = {formula: `AO${dIdx}-AP${dIdx}`};
                    }
                    sheetD.getCell(`AP${dIdx}`).numFmt = '0.00';
                    sheetD.getCell(`AQ${dIdx}`).numFmt = '0.00';

                    // AR 都更前後建物總產權差異(坪) = AO - AN
                    if (isPureValue) {
                        const anVal = parseFloat(sheetD.getCell(`AN${dIdx}`).value) || 0;
                        const aoVal = parseFloat(sheetD.getCell(`AO${dIdx}`).value) || 0;
                        sheetD.getCell(`AR${dIdx}`).value = aoVal - anVal;
                    } else {
                        sheetD.getCell(`AR${dIdx}`).value = {formula: `AO${dIdx}-AN${dIdx}`};
                    }
                    sheetD.getCell(`AR${dIdx}`).numFmt = '0.00';

                    // AS 主建物差異(坪) = AP - (原主建物持分坪 = AG*AJ)
                    if (isPureValue) {
                        const apVal = parseFloat(sheetD.getCell(`AP${dIdx}`).value) || 0;
                        sheetD.getCell(`AS${dIdx}`).value = apVal - (bMain * 0.3025 * bScope);
                    } else {
                        sheetD.getCell(`AS${dIdx}`).value = {formula: `AP${dIdx}-AG${dIdx}*AJ${dIdx}`};
                    }
                    sheetD.getCell(`AS${dIdx}`).numFmt = '0.00';

                    // AT 1樓換取2樓以上可分面積（預留，待使用者輸入）
                    sheetD.getCell(`AT${dIdx}`).value = '';

                    // AU 1樓建物總產權差異(坪)（預留）
                    sheetD.getCell(`AU${dIdx}`).value = '';

                    // AV 所有權人地址
                    sheetD.getCell(`AV${dIdx}`).value = exportData[num]['所有權地址'][i] || '';
                }
            }

            // AC～AV 欄格式
            ['AF','AG','AH','AI','AK','AL','AM','AN','AO','AP','AQ','AR','AS'].forEach(col => {
                sheetD.getColumn(col).style = { numFmt: '0.00' };
            });
            // AJ 欄格式已在每個 cell 個別設定（精確分子/分母字串）
        }
        goD();
    }

    // -------------------------------------------------------
    // 5. Sheet E: 基本分析
    // -------------------------------------------------------
    if (selectedSheets.includes('基本分析')) {
        const sheetE = workbook.addWorksheet('基本分析');
        sheetE.columns = [
            { header: '項目', key: 'item', width: 15 },
            { header: '說明', key: 'desc', width: 20 },
            { header: '數值', key: 'value', width: 15 },
            { header: '備註', key: 'note', width: 20 },
            { key: 'col5', width: 10 },
            { key: 'col6', width: 10 },
            { key: 'col7', width: 10 }
        ];
    }

    // -------------------------------------------------------
    // 匯出檔案
    // -------------------------------------------------------
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    
    // 依據篩選條件產生動態檔名
    let fileName = `${basics['地段']}_進階分析報表.xlsx`;
    if (filterConfig.type === 'land') fileName = `${basics['地段']}_地號${filterConfig.value}_分析報表.xlsx`;
    else if (filterConfig.type === 'owner') fileName = `${basics['地段']}_${filterConfig.value}_分析報表.xlsx`;
    
    saveAs(blob, fileName);

    // 輔助函數：處理儲存格合併
    function mergeCheck(sheet, key, start, end) {
        if (start === end) return;
        let startVal = sheet.getCell(`${key}${start}`).value;
        let startIdx = start;

        for (let i = start + 1; i <= end; i++) {
            let val = sheet.getCell(`${key}${i}`).value;

            if (val !== startVal) {
                if (startVal != null && i - startIdx > 1) {
                    sheet.mergeCells(`${key}${startIdx}:${key}${i - 1}`);
                }
                startVal = val;
                startIdx = i;
            } 
            else if (i === end) {
                if (startVal != null && i > startIdx) {
                    sheet.mergeCells(`${key}${startIdx}:${key}${i}`);
                }
            }
        }
    }
}

function mergeCheck(sheet, key, start, end) {
    if (start === end) {
        return;
    }
    let startVal = sheet.getCell(`${key}${start}`).value;
    let startIdx = start;

    for (let i = start + 1; i <= end; i++) {
        let val = sheet.getCell(`${key}${i}`).value;

        if (val !== startVal) {
            if (startVal != null && i - startIdx > 1) {
                sheet.mergeCells(`${key}${startIdx}:${key}${i - 1}`);
            }
            startVal = val;
            startIdx = i;
        } 
        else if (i === end) {
            if (startVal != null && i > startIdx) {
                sheet.mergeCells(`${key}${startIdx}:${key}${i}`);
            }
        }
    }
}

function addTotalRow(sheet, keys, isPureValue) {
    const currentRowIndex = sheet.rowCount + 1;
    const totalRow = sheet.getRow(currentRowIndex);
    
    totalRow.getCell(4).value = "總計";
    keys.forEach(key => {
        const colLetter = key;
        if (isPureValue) {
            let sum = 0;
            for(let i = 4; i < currentRowIndex; i++) {
                const val = sheet.getCell(`${colLetter}${i}`).value;
                sum += (typeof val === 'number') ? val : 0;
            }
            sheet.getCell(`${colLetter}${currentRowIndex}`).value = sum;
        } else {
            sheet.getCell(`${colLetter}${currentRowIndex}`).value = {
                formula: `SUM(${colLetter}4:${colLetter}${currentRowIndex-1})`
            };
        }
    });

    totalRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFf2f2f2' } };
        cell.font = { bold: true };
    });
}

// 修改原先的按鈕點擊事件 (在 DOMContentLoaded 內或全域)
const exportBtn = document.getElementById('export-excel');
if (exportBtn) {
    // 移除舊的 event listener 並綁定新的
    exportBtn.onclick = (e) => {
        e.preventDefault();
        openExportModal();
    };
}