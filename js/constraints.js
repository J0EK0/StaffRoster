// 個別員工的請假/偏好設定 modal
// 資料模型:
// constraints[staffId] = { [date]: 'N' | '休' | '請' | ... }
// 全月限制: forbidden / fixedShift 在 staff 物件裡
// 月內個別請假/偏好: 存於 schedule meta

const Constraints = (() => {
  function load(y, m) {
    const raw = localStorage.getItem(LS_KEYS.constraints(y, m));
    if (!raw) return {};
    try { return JSON.parse(raw); } catch(e) { return {}; }
  }

  function save(y, m, data) {
    localStorage.setItem(LS_KEYS.constraints(y, m), JSON.stringify(data));
  }

  function setStaffDay(data, staffId, dateKey, code) {
    const next = { ...data };
    if (!next[staffId]) next[staffId] = {};
    if (code === '' || code == null) {
      const copy = { ...next[staffId] };
      delete copy[dateKey];
      next[staffId] = copy;
    } else {
      next[staffId] = { ...next[staffId], [dateKey]: code };
    }
    return next;
  }

  function clearStaff(data, staffId) {
    const next = { ...data };
    delete next[staffId];
    return next;
  }

  // 渲染 modal：給某員工挑「該月哪天想休或想上什麼班」
  function openModal(staff, year, month, monthDays, allConstraints, onSave) {
    const modal = document.getElementById('constraint-modal');
    const title = document.getElementById('constraint-modal-title');
    const content = document.getElementById('constraint-modal-content');
    title.textContent = `設定限制：${staff.name}`;
    const staffData = (allConstraints[staff.id]) || {};

    // 班別選項：依員工是否禁忌排除
    const forbidden = new Set(staff.forbidden || []);
    const fixed = staff.fixedShift;

    const options = SHIFT_DEFS
      .filter(s => !forbidden.has(s.code) && !forbidden.has(effectiveWorkCode(s.code)))
      .map(s => `<option value="${s.code}">${s.code} (${s.label})</option>`)
      .join('');

    let html = '';

    if (staff.note) {
      html += `<div class="constraint-section"><div style="background:#fff3cd;padding:6px 10px;border-radius:6px;font-size:12px;color:#664d03;">📌 ${staff.note}</div></div>`;
    }

    // 全月設定區塊
    html += `<div class="constraint-section">
      <h4>全月設定（會覆寫所有預設規則）</h4>
      <label><input type="checkbox" id="ck-fixed-shift" ${fixed?'checked':''}> 全月固定班別：</label>
      <select id="sel-fixed-shift" ${fixed?'':'disabled'}>
        <option value="">--選擇--</option>
        ${SHIFT_DEFS.filter(s=>!isCircleShiftCode(s.code)).map(s=>`<option value="${s.code}" ${fixed===s.code?'selected':''}>${s.code} (${s.label})</option>`).join('')}
      </select>
      <br>
      <label>禁忌班別（不可被排）：</label>
      ${SHIFT_DEFS.filter(s=>s.kind==='work' && !isRestWorkCode(s.code) && !isCircleShiftCode(s.code)).map(s=>
        `<label><input type="checkbox" class="ck-forbid" value="${s.code}" ${(staff.forbidden||[]).includes(s.code)?'checked':''}> ${s.code}</label>`
      ).join('')}
    </div>`;

    // 個別日期設定
    html += `<div class="constraint-section"><h4>個別日期 ─ 預先指定（請假 / 想上的班）</h4>`;
    html += `<div class="cgrid">`;
    monthDays.forEach(d => {
      const isWeekend = (d.dow === 0 || d.dow === 6);
      const cls = ['cday'];
      if (isWeekend) cls.push('weekend');
      if (d.isHoliday) cls.push('holiday');
      const cur = staffData[d.date] || '';
      const labelColor = d.isHoliday ? '#c00' : '#6b7280';
      html += `<div class="${cls.join(' ')}">
        <div class="num">${d.day} (${DOW_LABEL[d.dow]})</div>
        ${d.holidayName ? `<div style="font-size:10px;color:${labelColor}">${d.holidayName}</div>`:''}
        <select data-date="${d.date}" class="sel-day">
          <option value="">-</option>
          ${options}
          ${forbidden.size ? SHIFT_DEFS.filter(s=>forbidden.has(s.code)).map(s=>'').join('') : ''}
          ${OFF_CODES.filter(c=>!options.includes(`value="${c}"`)).map(c=>{
            const def = SHIFT_MAP[c];
            return `<option value="${c}">${c} (${def.label})</option>`;
          }).join('')}
        </select>
      </div>`;
    });
    html += `</div></div>`;

    content.innerHTML = html;

    // 設定預選值
    content.querySelectorAll('.sel-day').forEach(sel => {
      const dateK = sel.dataset.date;
      if (staffData[dateK]) sel.value = staffData[dateK];
    });

    // checkbox 勾選/取消固定班 → enable/disable select
    const ckFixed = content.querySelector('#ck-fixed-shift');
    const selFixed = content.querySelector('#sel-fixed-shift');
    ckFixed.addEventListener('change', () => {
      selFixed.disabled = !ckFixed.checked;
      if (!ckFixed.checked) selFixed.value = '';
    });

    modal.classList.remove('hidden');

    // 綁定按鈕
    const saveBtn = document.getElementById('btn-constraint-save');
    const cancelBtn = document.getElementById('btn-constraint-cancel');
    const closeBtn = document.getElementById('btn-modal-close');
    const onClose = () => {
      modal.classList.add('hidden');
      saveBtn.removeEventListener('click', onSubmit);
      cancelBtn.removeEventListener('click', onClose);
      closeBtn.removeEventListener('click', onClose);
    };
    const onSubmit = () => {
      // 收集
      const newStaffData = {};
      content.querySelectorAll('.sel-day').forEach(sel => {
        const v = sel.value;
        if (v) newStaffData[sel.dataset.date] = v;
      });
      const newForbidden = Array.from(content.querySelectorAll('.ck-forbid'))
        .filter(c=>c.checked).map(c=>c.value);
      const newFixed = ckFixed.checked && selFixed.value ? selFixed.value : null;

      onSave({
        staffPatch: {
          forbidden: newForbidden.length ? newForbidden : undefined,
          fixedShift: newFixed || undefined,
        },
        constraintData: newStaffData,
      });
      onClose();
    };
    saveBtn.addEventListener('click', onSubmit);
    cancelBtn.addEventListener('click', onClose);
    closeBtn.addEventListener('click', onClose);
  }

  return { load, save, setStaffDay, clearStaff, openModal };
})();
