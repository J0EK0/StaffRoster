// Excel 匯出 (使用 SheetJS)

const Exporter = (() => {
  const STAT_CODES = ['N','E','3','7','1','2','中','△','A','◎','休*','休','例','國'];

  const PALETTES = {
    vivid: {
      fill: {
        'N':'1E3A8A','E':'3B82F6','3':'60A5FA','7':'93C5FD',
        '1':'FDE68A','2':'FCD34D','中':'FBBF24','△':'F97316',
        'A':'C084FC','R':'A855F7','門':'F472B6','白':'E5E7EB','休*':'34D399',
        '休N':'1E3A8A','休E':'3B82F6','◎':'A855F7',
        '休':'CBD5E1','例':'94A3B8','國':'F87171','請':'FCD9B6'
      },
      font: {
        'N':'FFFFFF','E':'FFFFFF','3':'FFFFFF','7':'1D2433',
        '1':'1D2433','2':'1D2433','中':'1D2433','△':'FFFFFF',
        'A':'FFFFFF','R':'FFFFFF','門':'FFFFFF','白':'1D2433','休*':'FFFFFF',
        '休N':'FFFFFF','休E':'FFFFFF','◎':'FFFFFF',
        '休':'1D2433','例':'FFFFFF','國':'FFFFFF','請':'1D2433'
      }
    },
    pastel: {
      fill: {
        'N':'DDE0F2','E':'DCE5F4','3':'DCE9F4','7':'E0EBF3',
        '1':'F1ECCB','2':'F2E6B8','中':'F3E1B3','△':'F4D6A8',
        'A':'ECDCEF','R':'ECDFEC','門':'F1DDE3','白':'F4F4F6','休*':'D8EDDC',
        '休N':'DDE0F2','休E':'DCE5F4','◎':'ECDFEC',
        '休':'F5DDD4','例':'F5DDD4','國':'F5DDD4','請':'F5DDD4'
      },
      font: {
        '休':'B91C1C','例':'B91C1C','國':'B91C1C','請':'B91C1C'
      }
    },
    none: {
      fill: {},
      font: {
        '休':'B91C1C','例':'B91C1C','國':'B91C1C','請':'B91C1C'
      }
    }
  };

  // ── CRC32（ZIP 用）──
  const _crcTab = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
      t[n] = v;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xFFFFFFFF >>> 0;
    for (let i = 0; i < buf.length; i++) c = (_crcTab[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ── 直接修補 xlsx ZIP 中的 sharedStrings.xml，注入 rich text ──
  // xlsx-js-style 不會從 cell 直接寫 rich text，因此輸出時開 bookSST，
  // 再找到 sharedStrings.xml（未壓縮）替換目標 <si> 並更新 ZIP metadata。
  function patchRichTextInZip(arr, richMap) {
    // richMap: Map<plainText, true> — 鍵為 "底稿 偏好" 格式的純文字
    if (!richMap || richMap.size === 0) return arr;

    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const v = new DataView(arr.buffer, arr.byteOffset, arr.byteLength);

    // 1. 找 EOCD (End of Central Directory)
    let eocd = -1;
    for (let i = arr.length - 22; i >= 0; i--) {
      if (arr[i] === 0x50 && arr[i+1] === 0x4B && arr[i+2] === 0x05 && arr[i+3] === 0x06) {
        eocd = i; break;
      }
    }
    if (eocd < 0) return arr;

    const cdOff = v.getUint32(eocd + 16, true);
    const cdSz  = v.getUint32(eocd + 12, true);
    const nEnt  = v.getUint16(eocd + 10, true);

    // 2. 解析 Central Directory，找 xl/sharedStrings.xml
    let p = cdOff, tgt = null;
    for (let i = 0; i < nEnt; i++) {
      const fl = v.getUint16(p + 28, true);
      const el = v.getUint16(p + 30, true);
      const cl = v.getUint16(p + 32, true);
      const name = dec.decode(arr.slice(p + 46, p + 46 + fl));
      if (name === 'xl/sharedStrings.xml') {
        tgt = {
          lfhOff: v.getUint32(p + 42, true),
          cSz: v.getUint32(p + 20, true),
          cp: p,
          method: v.getUint16(p + 10, true)
        };
      }
      p += 46 + fl + el + cl;
    }
    if (!tgt) return arr;
    if (tgt.method !== 0) return arr;

    // 3. 讀取 Local File Header → 定位資料區段
    const lf = v.getUint16(tgt.lfhOff + 26, true);
    const le = v.getUint16(tgt.lfhOff + 28, true);
    const ds = tgt.lfhOff + 30 + lf + le;
    const de = ds + tgt.cSz;
    const origXml = dec.decode(arr.slice(ds, de));

    // 4. 替換目標 <si> 條目
    const xe = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xd = s => String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    let anyReplaced = false;
    const newXml = origXml.replace(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g, (m, text) => {
      const key = xd(text);
      if (!richMap.has(key)) return m;
      const parts = key.split(' ');
      const constraint = parts.pop();
      const draft = parts.join(' ');
      if (!draft || !constraint) return m;
      anyReplaced = true;
      const col1 = (draft === '休' || draft === '例') ? 'FFB91C1C' : 'FF1D2433';
      const col2 = constraint === '請' ? 'FFC0392B' : 'FF1D4ED8';
      return '<si>' +
        '<r><rPr><b/><color rgb="' + col1 + '"/></rPr><t xml:space="preserve">' + xe(draft) + '</t></r>' +
        '<r><rPr><b/><color rgb="' + col2 + '"/></rPr><t xml:space="preserve"> ' + xe(constraint) + '</t></r>' +
        '</si>';
    });
    if (!anyReplaced) return arr;

    // 5. 重算 CRC32、大小、偏移，重組 ZIP bytes
    const nd = enc.encode(newXml);
    const nC = crc32(nd), nS = nd.length, df = nS - tgt.cSz;

    const pre = new Uint8Array(arr.slice(0, ds));
    const dv  = new DataView(pre.buffer);
    dv.setUint32(tgt.lfhOff + 14, nC, true);  // CRC32
    dv.setUint32(tgt.lfhOff + 18, nS, true);  // 壓縮大小
    dv.setUint32(tgt.lfhOff + 22, nS, true);  // 未壓縮大小

    const mid = new Uint8Array(arr.slice(de, cdOff));
    const cd  = new Uint8Array(arr.slice(cdOff, cdOff + cdSz));
    const cdv = new DataView(cd.buffer);
    const rp  = tgt.cp - cdOff;
    cdv.setUint32(rp + 16, nC, true);
    cdv.setUint32(rp + 20, nS, true);
    cdv.setUint32(rp + 24, nS, true);

    // 更新 CD 中其他 entry 的 LFH 偏移（若 sharedStrings 不是最後一個 local file）
    if (df !== 0) {
      let q = 0;
      for (let i = 0; i < nEnt; i++) {
        const off = cdv.getUint32(q + 42, true);
        if (off > tgt.lfhOff) cdv.setUint32(q + 42, off + df, true);
        q += 46 + cdv.getUint16(q + 28, true) + cdv.getUint16(q + 30, true) + cdv.getUint16(q + 32, true);
      }
    }

    const ep  = new Uint8Array(arr.slice(eocd));
    new DataView(ep.buffer).setUint32(16, cdOff + df, true);  // EOCD: CD 起始偏移

    const out = new Uint8Array(pre.length + nd.length + mid.length + cd.length + ep.length);
    let o = 0;
    out.set(pre, o); o += pre.length;
    out.set(nd,  o); o += nd.length;
    out.set(mid, o); o += mid.length;
    out.set(cd,  o); o += cd.length;
    out.set(ep,  o);
    return out;
  }

  function triggerDownload(arr, filename) {
    const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readTweaks() {
    try {
      const raw = localStorage.getItem('roster.tweaks');
      if (raw) return JSON.parse(raw) || {};
    } catch (e) {}
    return {};
  }

  function readConstraints(year, month) {
    try {
      const raw = localStorage.getItem(LS_KEYS.constraints(year, month));
      if (raw) return JSON.parse(raw) || {};
    } catch (e) {}
    return {};
  }

  function circleRestDebitCount(assignments, constraints, staffMember, days) {
    if (!isCircleStaff(staffMember)) return 0;
    const row  = assignments[staffMember.id] || {};
    const manual = constraints[staffMember.id] || {};
    let circles = 0, manualWeekdayRest = 0;
    days.forEach(d => {
      if (row[d.date] === '◎' && isCircleDay(d)) circles++;
      if (manual[d.date] === '休' && isWeekdayRestCreditDay(d)) manualWeekdayRest++;
    });
    return Math.max(0, circles - manualWeekdayRest);
  }

  function detectHasDraft(assignments, constraints) {
    const as = assignments || {}, cs = constraints || {};
    for (const sid in as) {
      const row = as[sid] || {}, pref = cs[sid] || {};
      for (const date in row) {
        if (row[date] && row[date] !== pref[date]) return true;
      }
    }
    return false;
  }

  function exportXlsx(schedule, staff, constraints) {
    const { year, month, days, assignments } = schedule;
    if (typeof XLSX === 'undefined') { alert('Excel 函式庫未載入，無法匯出'); return; }

    const tweaks     = readTweaks();
    const hideWhite  = tweaks.white === 'hidden';
    const colorMode  = PALETTES[tweaks.color] ? tweaks.color : 'none';
    const palette    = PALETTES[colorMode];
    const cons       = constraints || readConstraints(year, month);
    const isDraft    = detectHasDraft(assignments, cons);

    const HOLIDAY_HEADER_FILL = 'FECACA';
    const HOLIDAY_BODY_FILL   = 'FEE2E2';
    const HOLIDAY_TEXT        = 'B91C1C';
    const WEEKEND_HEADER_FILL = 'E0F2FE';

    const aoa = [];

    // 表頭第一列：日期
    const header = ['姓名'];
    days.forEach(d => header.push(d.day));
    header.push(...STAT_CODES, '上班');
    aoa.push(header);

    // 表頭第二列：星期
    const dowRow = [''];
    days.forEach(d => dowRow.push(DOW_LABEL[d.dow] + (d.isHoliday ? '*' : '')));
    STAT_CODES.forEach(() => dowRow.push(''));
    dowRow.push('');
    aoa.push(dowRow);

    // richMap: 記錄哪些「底稿\n偏好」組合需要 rich text，供後續 ZIP 修補
    const richMap = new Map();

    staff.forEach(s => {
      const row   = [s.name];
      const stats = {};
      STAT_CODES.forEach(code => { stats[code] = 0; });
      let workC = 0;
      let circleRestToCount = circleRestDebitCount(assignments, cons, s, days);

      const addShiftStats = code => {
        if (!code) return;
        if (isCircleShiftCode(code)) {
          if (stats['◎'] !== undefined) stats['◎']++;
          if (circleRestToCount > 0 && stats['休'] !== undefined) { stats['休']++; circleRestToCount--; }
          return;
        }
        if (isRestWorkCode(code)) {
          const base = effectiveWorkCode(code);
          if (stats[base] !== undefined) stats[base]++;
          if (stats['休']  !== undefined) stats['休']++;
          return;
        }
        if (stats[code] !== undefined) stats[code]++;
      };

      days.forEach(d => {
        let c = assignments[s.id] ? (assignments[s.id][d.date] || '') : '';
        if (hideWhite && c === '白') c = '';

        const rawConstraint = (cons[s.id] && cons[s.id][d.date]) || '';
        const constraint = (hideWhite && rawConstraint === '白') ? '' : rawConstraint;

        if (isDraft && c && constraint && constraint !== c) {
          // 底稿 + 偏好都存在且不同 → 放複合字串，稍後 ZIP 修補為 rich text
          const combined = c + ' ' + constraint;
          row.push(combined);
          richMap.set(combined, true);
        } else {
          row.push(c);
        }

        addShiftStats(c);  // 統計永遠用底稿
        if (c && !OFF_CODES.includes(c)) workC++;
      });

      STAT_CODES.forEach(code => row.push(stats[code]));
      row.push(workC);
      aoa.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // 欄寬
    ws['!cols'] = [{ wch: 10 }];
    for (let i = 0; i < days.length; i++) ws['!cols'].push({ wch: isDraft ? 5 : 4 });
    for (let i = 0; i < STAT_CODES.length + 1; i++) ws['!cols'].push({ wch: 5 });

    ws['!freeze'] = { xSplit: 1, ySplit: 2 };

    const range = XLSX.utils.decode_range(ws['!ref']);

    for (let R = 0; R <= range.e.r; R++) {
      for (let C = 0; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[addr];
        if (!cell) continue;

        // 表頭兩列
        if (R === 0 || R === 1) {
          if (C >= 1 && C <= days.length) {
            const d = days[C - 1];
            if (d.isHoliday) {
              cell.s = { fill: { fgColor: { rgb: HOLIDAY_HEADER_FILL } }, font: { bold: true, color: { rgb: HOLIDAY_TEXT } }, alignment: { horizontal: 'center', vertical: 'center' } };
            } else if (d.dow === 0 || d.dow === 6) {
              cell.s = { fill: { fgColor: { rgb: WEEKEND_HEADER_FILL } }, font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } };
            } else {
              cell.s = { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } };
            }
          } else if (C === 0) {
            cell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'F0F2F7' } } };
          }
          continue;
        }

        if (C === 0) { cell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'F8F9FB' } } }; continue; }

        if (C >= 1 && C <= days.length) {
          const d = days[C - 1];
          const isHoliday = d && d.isHoliday;
          const raw = String(cell.v || '');

          // rich text 格子（底稿 + 偏好）：底色用底稿班別色
          const isRich = isDraft && richMap.has(raw);
          const displayCode = isRich ? raw.split(' ')[0] : raw;
          const fillRgb = palette.fill[displayCode];
          const fontRgb = palette.font[displayCode];

          if (raw) {
            const style = {
              font:      isRich
                ? { bold: true }
                : { bold: true, color: { rgb: isHoliday ? HOLIDAY_TEXT : (fontRgb || '1D2433') } },
              alignment: { horizontal: 'center', vertical: 'center' }
            };
            if (fillRgb)       style.fill = { fgColor: { rgb: fillRgb } };
            else if (isHoliday) style.fill = { fgColor: { rgb: HOLIDAY_BODY_FILL } };
            cell.s = style;
          } else if (isHoliday) {
            cell.s = { fill: { fgColor: { rgb: HOLIDAY_BODY_FILL } }, alignment: { horizontal: 'center', vertical: 'center' } };
          } else {
            cell.s = { alignment: { horizontal: 'center', vertical: 'center' } };
          }
        }
      }
    }

    const wb = XLSX.utils.book_new();
    const sheetName = `${year}-${String(month).padStart(2, '0')}`;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    const suffix   = isDraft ? '_底稿' : '';
    const filename = `班表_${year}-${String(month).padStart(2, '0')}${suffix}.xlsx`;

    if (isDraft && richMap.size > 0) {
      // 輸出 Uint8Array → ZIP 修補 sharedStrings.xml → blob 下載
      const raw = XLSX.write(wb, { bookType: 'xlsx', cellStyles: true, bookSST: true, type: 'array' });
      const patched = patchRichTextInZip(new Uint8Array(raw), richMap);
      triggerDownload(patched, filename);
    } else {
      XLSX.writeFile(wb, filename, { bookType: 'xlsx', cellStyles: true });
    }
  }

  return { exportXlsx };
})();
