// Excel 匯出 (使用 SheetJS)

const Exporter = (() => {
  const STAT_CODES = ['N','E','3','7','1','2','中','△','A','◎','休*','休','例','國'];

  // 三種色彩模式：vivid（深飽和）、pastel（淡色塊）、none（純文字）
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
        // pastel 一律深字，紅色休假類用 warn red 字色
        '休':'B91C1C','例':'B91C1C','國':'B91C1C','請':'B91C1C'
      }
    },
    none: {
      // 無底色，只用字色區分休假
      fill: {},
      font: {
        '休':'B91C1C','例':'B91C1C','國':'B91C1C','請':'B91C1C'
      }
    }
  };

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
    const row = assignments[staffMember.id] || {};
    const manual = constraints[staffMember.id] || {};
    let circles = 0;
    let manualWeekdayRest = 0;
    days.forEach(d => {
      if (row[d.date] === '◎' && isCircleDay(d)) circles++;
      if (manual[d.date] === '休' && isWeekdayRestCreditDay(d)) manualWeekdayRest++;
    });
    return Math.max(0, circles - manualWeekdayRest);
  }

  function exportXlsx(schedule, staff) {
    const { year, month, days, assignments } = schedule;
    if (typeof XLSX === 'undefined') {
      alert('Excel 函式庫未載入，無法匯出');
      return;
    }

    const tweaks = readTweaks();
    const hideWhite = tweaks.white === 'hidden';
    const colorMode = PALETTES[tweaks.color] ? tweaks.color : 'none';
    const palette = PALETTES[colorMode];
    const constraints = readConstraints(year, month);

    // 假日色調（表頭深一點、表身深一層，文字紅色）
    const HOLIDAY_HEADER_FILL = 'FECACA';   // 較鮮明的紅
    const HOLIDAY_BODY_FILL   = 'FEE2E2';   // 身體列淺紅底
    const HOLIDAY_TEXT        = 'B91C1C';   // 紅色字
    const WEEKEND_HEADER_FILL = 'E0F2FE';   // 冷色週末（與現行 UI 一致）

    // 建立 worksheet 用 array of arrays
    // Row 0: 標題列 (姓名, 1, 2, ..., 31, 各特殊班統計)
    // Row 1: 星期列
    // Row 2+: 每位員工
    const aoa = [];

    // Header row 1: 日期
    const header = ['姓名'];
    days.forEach(d => header.push(d.day));
    header.push(...STAT_CODES, '上班');
    aoa.push(header);

    // Header row 2: 星期
    const dowRow = [''];
    days.forEach(d => dowRow.push(DOW_LABEL[d.dow] + (d.isHoliday?'*':'')));
    STAT_CODES.forEach(() => dowRow.push(''));
    dowRow.push('');
    aoa.push(dowRow);

    // 員工列
    staff.forEach(s => {
      const row = [s.name];
      const stats = {};
      STAT_CODES.forEach(code => { stats[code] = 0; });
      let workC=0;
      let circleRestToCount = circleRestDebitCount(assignments, constraints, s, days);
      const addShiftStats = (code) => {
        if (!code) return;
        if (isCircleShiftCode(code)) {
          if (stats['◎'] !== undefined) stats['◎']++;
          if (circleRestToCount > 0 && stats['休'] !== undefined) {
            stats['休']++;
            circleRestToCount--;
          }
          return;
        }
        if (isRestWorkCode(code)) {
          const base = effectiveWorkCode(code);
          if (stats[base] !== undefined) stats[base]++;
          if (stats['休'] !== undefined) stats['休']++;
          return;
        }
        if (stats[code] !== undefined) stats[code]++;
      };
      days.forEach(d => {
        let c = assignments[s.id] ? (assignments[s.id][d.date] || '') : '';
        // 如果 Tweaks 設為「隱藏白班」→ 匯出時白班不顯示
        if (hideWhite && c === '白') c = '';
        row.push(c);
        addShiftStats(c);
        if (c && !OFF_CODES.includes(c)) workC++;
      });
      STAT_CODES.forEach(code => row.push(stats[code]));
      row.push(workC);
      aoa.push(row);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // 設定欄寬：第一欄較寬，其他窄
    const cols = [{ wch: 10 }];
    for (let i = 0; i < days.length; i++) cols.push({ wch: 4 });
    for (let i = 0; i < STAT_CODES.length + 1; i++) cols.push({ wch: 5 });
    ws['!cols'] = cols;

    // 凍結 (前兩列、第一欄)
    ws['!freeze'] = { xSplit: 1, ySplit: 2 };

    // 設定每格樣式 (SheetJS 社群版有限支援，改為加註背景色用 cell.s 風格)
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = 0; R <= range.e.r; R++) {
      for (let C = 0; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({r:R,c:C});
        const cell = ws[addr];
        if (!cell) continue;

        // 第一列（日期）：六/日/國定染色
        if (R === 0 || R === 1) {
          if (C >= 1 && C <= days.length) {
            const d = days[C-1];
            if (d.isHoliday) {
              cell.s = {
                fill:{ fgColor:{ rgb: HOLIDAY_HEADER_FILL } },
                font:{ bold:true, color:{ rgb: HOLIDAY_TEXT } },
                alignment:{ horizontal:'center', vertical:'center' }
              };
            } else if (d.dow === 0 || d.dow === 6) {
              cell.s = {
                fill:{ fgColor:{ rgb: WEEKEND_HEADER_FILL } },
                font:{ bold:true },
                alignment:{ horizontal:'center', vertical:'center' }
              };
            } else {
              cell.s = { font:{bold:true}, alignment:{ horizontal:'center', vertical:'center' } };
            }
          } else if (C === 0) {
            cell.s = { font:{bold:true}, fill:{fgColor:{rgb:'F0F2F7'}} };
          }
          continue;
        }

        // 員工列：第一欄姓名
        if (C === 0) {
          cell.s = { font:{bold:true}, fill:{fgColor:{rgb:'F8F9FB'}} };
          continue;
        }

        // 班別格子染色
        if (C >= 1 && C <= days.length) {
          const d = days[C-1];
          const code = String(cell.v || '');
          const isHoliday = d && d.isHoliday;

          const fillRgb = palette.fill[code];
          const fontRgb = palette.font[code];

          if (code) {
            const style = {
              font: {
                bold: true,
                color: { rgb: isHoliday ? HOLIDAY_TEXT : (fontRgb || '1D2433') }
              },
              alignment: { horizontal:'center', vertical:'center' }
            };
            if (fillRgb) {
              style.fill = { fgColor: { rgb: fillRgb } };
            } else if (isHoliday) {
              style.fill = { fgColor: { rgb: HOLIDAY_BODY_FILL } };
            }
            cell.s = style;
          } else if (isHoliday) {
            // 空格但是假日 → 淺紅底
            cell.s = {
              fill:{ fgColor:{ rgb: HOLIDAY_BODY_FILL } },
              alignment:{ horizontal:'center', vertical:'center' }
            };
          } else {
            cell.s = { alignment:{ horizontal:'center', vertical:'center' } };
          }
        }
      }
    }

    const wb = XLSX.utils.book_new();
    const sheetName = `${year}-${String(month).padStart(2,'0')}`;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    // 寫檔
    const filename = `班表_${year}-${String(month).padStart(2,'0')}.xlsx`;
    XLSX.writeFile(wb, filename, { bookType:'xlsx', cellStyles:true });
  }

  return { exportXlsx };
})();
