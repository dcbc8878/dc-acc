/* ============================================================================
   datefield.js — ช่องกรอกวันที่รูปแบบ dd/mm/yyyy ที่ใช้ร่วมกันทั้งเว็บ
   ----------------------------------------------------------------------------
   ปัญหาที่แก้: <input type="date"> ของเบราว์เซอร์แสดงรูปแบบตาม "ภาษาของเบราว์เซอร์"
   ไม่ใช่ตามที่หน้าเว็บกำหนด (เครื่องที่ตั้งเป็นอังกฤษ-สหรัฐฯ จะเห็น mm/dd/yyyy)
   สั่งด้วย CSS/attribute ไม่ได้เลย ทางเดียวคือทำช่องกรอกเอง — CRM ทำไว้แล้ว
   (fmtDDMMYYYY/parseDDMMYYYY/openDatePicker ในไฟล์ CRM) ไฟล์นี้คือตัวเดียวกันในรูปแบบ
   ที่หน้ารวม/ปฏิทิน/พนักงาน-ทีม เรียกใช้ร่วมกันได้ โดยไม่ต้องไปแก้โค้ดเดิมทีละจุด

   วิธีทำงาน (สำคัญ — ออกแบบให้ "ไม่ต้องแก้โค้ดเดิม"):
   ตัว <input type="date"> เดิม *ยังอยู่ใน DOM เหมือนเดิมทุกประการ* แค่ถูกซ่อนไว้ แล้ววาง
   ช่องข้อความ dd/mm/yyyy ไว้ข้างหน้าแทน — โค้ดเดิมที่อ่าน/เขียน el.value ยังได้ค่า ISO
   ("YYYY-MM-DD") เหมือนเดิมทุกจุด และ event input/change ยังยิงตามปกติ
   (การเขียน el.value = '...' จากโค้ดก็อัปเดตช่องที่มองเห็นให้เองผ่าน property override)

   ใช้งาน:
     <script src="./datefield.js?v=__BUILD__"></script>   (โหลดก่อน DOMContentLoaded ก็พอ)
     DCDate.enhance(el)   // เรียกหลังใส่ HTML ใหม่เข้า DOM เอง (เช่น modal ที่สร้างด้วย innerHTML)
     DCDate.fmt(iso)      // "2026-09-08" -> "08/09/2026"
     DCDate.parse(str)    // "08/09/2026" -> "2026-09-08" (คืน null ถ้าไม่ถูกต้อง เช่น 31/02/2026)
   ========================================================================== */
(function () {
  'use strict';
  if (window.DCDate) return;

  var MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  var DOW = ['อา','จ','อ','พ','พฤ','ศ','ส'];

  function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }

  // "2026-09-08" (หรือ timestamp เต็มที่ขึ้นต้นด้วยรูปแบบนี้) -> "08/09/2026"
  function fmt(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  // "8/9/2026" -> "2026-09-08" · คืน null ถ้าไม่ครบ/ไม่ใช่วันที่จริง (เช่น 31/02) ตรงกับ
  // parseDDMMYYYY ของ CRM ทุกกฎ (รวมช่วงปีที่ยอมรับ ค.ศ. 1900-2100)
  function parse(str) {
    var m = String(str == null ? '' : str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    var d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    if (y < 1900 || y > 2100) return null;
    var iso = y + '-' + pad(mo) + '-' + pad(d);
    var dt = new Date(iso + 'T00:00:00');
    if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo || dt.getDate() !== d) return null;
    return iso;
  }

  // เติม "/" ให้เองระหว่างพิมพ์ (พิมพ์ 08092026 ได้ 08/09/2026)
  function autoSlash(v) {
    var g = String(v == null ? '' : v).replace(/[^\d]/g, '').slice(0, 8);
    if (g.length <= 2) return g;
    if (g.length <= 4) return g.slice(0, 2) + '/' + g.slice(2);
    return g.slice(0, 2) + '/' + g.slice(2, 4) + '/' + g.slice(4);
  }

  function todayIso() {
    var t = new Date();
    return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  }

  // ── สไตล์ (ฝังครั้งเดียว) ────────────────────────────────────────────────
  // ใช้ตัวแปรสีของหน้าที่โหลดไฟล์นี้ ถ้าหน้านั้นไม่มีชื่อตัวแปรตัวใดก็ไล่ไปตัวถัดไปจนถึงค่าตายตัว
  // (แต่ละแอปตั้งชื่อโทเคนไม่เหมือนกัน: --surface/--ink ของ CRM, --panel/--text ของปฏิทิน ฯลฯ)
  function injectStyle() {
    if (document.getElementById('dcd-style')) return;
    var s = document.createElement('style');
    s.id = 'dcd-style';
    s.textContent = [
      '#dcd-pop{position:fixed;z-index:99999;display:none;width:250px;padding:8px;border-radius:10px;',
      '  background:var(--surface,var(--panel,#fff));color:var(--ink,var(--text,#111));',
      '  border:1px solid var(--border,#d8d5cd);box-shadow:0 10px 30px rgba(0,0,0,.18);',
      '  font-family:inherit;font-size:12.5px;box-sizing:border-box}',
      '#dcd-pop .dcd-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}',
      '#dcd-pop .dcd-nav{border:none;background:transparent;cursor:pointer;font-size:15px;line-height:1;',
      '  padding:2px 8px;border-radius:6px;color:inherit;font-family:inherit}',
      '#dcd-pop .dcd-nav:hover{background:var(--surface-2,var(--panel-2,rgba(0,0,0,.06)))}',
      '#dcd-pop .dcd-title{font-weight:700;font-size:12.5px}',
      '#dcd-pop .dcd-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}',
      '#dcd-pop .dcd-dow{text-align:center;font-size:10px;opacity:.6;padding:2px 0}',
      '#dcd-pop .dcd-day{border:none;background:transparent;cursor:pointer;border-radius:6px;',
      '  padding:5px 0;font-size:12px;color:inherit;font-family:inherit}',
      '#dcd-pop .dcd-day:hover:not(:disabled){background:var(--surface-2,var(--panel-2,rgba(0,0,0,.08)))}',
      '#dcd-pop .dcd-day.dcd-out{opacity:.32}',
      '#dcd-pop .dcd-day.dcd-today{outline:1px solid var(--accent,#2F5D50)}',
      '#dcd-pop .dcd-day.dcd-sel{background:var(--accent,#2F5D50);color:#fff;font-weight:700}',
      '#dcd-pop .dcd-day:disabled{opacity:.25;cursor:default}',
      '#dcd-pop .dcd-foot{display:flex;gap:6px;margin-top:7px}',
      '#dcd-pop .dcd-foot button{flex:1;border:1px solid var(--border,#d8d5cd);background:transparent;',
      '  border-radius:6px;padding:4px 0;font-size:11.5px;cursor:pointer;color:inherit;font-family:inherit}',
      '#dcd-pop .dcd-foot button:hover{background:var(--surface-2,var(--panel-2,rgba(0,0,0,.06)))}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── หน้าต่างเลือกวันที่ (มีตัวเดียวใช้ร่วมกันทุกช่อง) ──────────────────────
  var pop = null, popTarget = null, popYear = 0, popMonth = 0;

  function ensurePop() {
    if (pop) return pop;
    injectStyle();
    pop = document.createElement('div');
    pop.id = 'dcd-pop';
    document.body.appendChild(pop);
    pop.addEventListener('mousedown', function (ev) { ev.preventDefault(); }); // กันช่องกรอกเสียโฟกัส
    return pop;
  }

  function closePop() {
    if (pop) pop.style.display = 'none';
    popTarget = null;
  }

  function openPop(ctl) {
    ensurePop();
    popTarget = ctl;
    var cur = ctl.getIso() || todayIso();
    popYear = parseInt(cur.slice(0, 4), 10);
    popMonth = parseInt(cur.slice(5, 7), 10);
    renderPop();
    pop.style.display = 'block';
    positionPop(ctl.disp);
  }

  function positionPop(anchor) {
    var r = anchor.getBoundingClientRect();
    var h = pop.offsetHeight || 260, w = pop.offsetWidth || 250;
    var top = r.bottom + 4;
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 4);
    var left = Math.min(r.left, window.innerWidth - w - 6);
    pop.style.top = Math.round(top) + 'px';
    pop.style.left = Math.round(Math.max(6, left)) + 'px';
  }

  function renderPop() {
    if (!popTarget) return;
    var sel = popTarget.getIso();
    var today = todayIso();
    var first = new Date(popYear, popMonth - 1, 1);
    var lead = first.getDay();
    var days = new Date(popYear, popMonth, 0).getDate();
    var prevDays = new Date(popYear, popMonth - 1, 0).getDate();
    var html = '<div class="dcd-head">' +
      '<button type="button" class="dcd-nav" data-dcd-nav="-1">‹</button>' +
      '<span class="dcd-title">' + MONTHS[popMonth - 1] + ' ' + popYear + '</span>' +
      '<button type="button" class="dcd-nav" data-dcd-nav="1">›</button></div><div class="dcd-grid">';
    for (var i = 0; i < 7; i++) html += '<div class="dcd-dow">' + DOW[i] + '</div>';
    for (var l = lead; l > 0; l--) {
      html += '<button type="button" class="dcd-day dcd-out" disabled>' + (prevDays - l + 1) + '</button>';
    }
    for (var d = 1; d <= days; d++) {
      var iso = popYear + '-' + pad(popMonth) + '-' + pad(d);
      var cls = 'dcd-day' + (iso === sel ? ' dcd-sel' : '') + (iso === today ? ' dcd-today' : '');
      var off = popTarget.inRange(iso) ? '' : ' disabled';
      html += '<button type="button" class="' + cls + '" data-dcd-iso="' + iso + '"' + off + '>' + d + '</button>';
    }
    html += '</div><div class="dcd-foot">' +
      '<button type="button" data-dcd-iso="' + today + '">วันนี้</button>' +
      '<button type="button" data-dcd-clear="1">ล้าง</button></div>';
    pop.innerHTML = html;
    pop.querySelectorAll('[data-dcd-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        popMonth += parseInt(b.getAttribute('data-dcd-nav'), 10);
        if (popMonth < 1) { popMonth = 12; popYear--; }
        if (popMonth > 12) { popMonth = 1; popYear++; }
        renderPop();
      });
    });
    pop.querySelectorAll('[data-dcd-iso]').forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener('click', function () {
        var iso = b.getAttribute('data-dcd-iso');
        if (!popTarget.inRange(iso)) return;
        popTarget.setIso(iso);
        closePop();
      });
    });
    var clr = pop.querySelector('[data-dcd-clear]');
    if (clr) clr.addEventListener('click', function () { popTarget.setIso(''); closePop(); });
  }

  document.addEventListener('mousedown', function (ev) {
    if (!pop || pop.style.display !== 'block') return;
    if (pop.contains(ev.target)) return;
    if (popTarget && ev.target === popTarget.disp) return;
    closePop();
  }, true);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePop(); });
  window.addEventListener('resize', function () { if (popTarget) positionPop(popTarget.disp); });
  window.addEventListener('scroll', function () { closePop(); }, true);

  // ── ต่อช่องกรอกจริง ──────────────────────────────────────────────────────
  var NATIVE_VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function wire(native) {
    if (native.getAttribute('data-dcdate')) return;
    native.setAttribute('data-dcdate', '1');
    injectStyle();

    var disp = document.createElement('input');
    disp.type = 'text';
    disp.setAttribute('inputmode', 'numeric');
    disp.setAttribute('autocomplete', 'off');
    disp.placeholder = native.getAttribute('placeholder') || 'dd/mm/yyyy';
    disp.maxLength = 10;
    if (native.className) disp.className = native.className;
    var st = native.getAttribute('style');
    if (st) disp.setAttribute('style', st);
    if (native.id) disp.id = native.id + '__dcd';
    if (native.disabled) disp.disabled = true;
    if (native.readOnly) disp.readOnly = true;
    // ย้าย required มาไว้ที่ช่องที่มองเห็น — ถ้าปล่อยไว้ที่ช่องที่ถูกซ่อน ฟอร์มที่ใช้ตัวตรวจของ
    // เบราว์เซอร์จะ submit ไม่ได้เลยและไม่มีอะไรแสดงให้ผู้ใช้เห็น ("not focusable")
    if (native.hasAttribute('required')) { native.removeAttribute('required'); disp.required = true; }

    native.parentNode.insertBefore(disp, native);
    native.style.display = 'none';
    native.setAttribute('aria-hidden', 'true');
    native.tabIndex = -1;

    if (native.id) {
      var labs = document.getElementsByTagName('label');
      for (var i = 0; i < labs.length; i++) {
        if (labs[i].htmlFor === native.id) labs[i].htmlFor = disp.id;
      }
    }

    var ctl = {
      disp: disp,
      getIso: function () { return NATIVE_VALUE.get.call(native) || ''; },
      inRange: function (iso) {
        var mn = native.getAttribute('min'), mx = native.getAttribute('max');
        if (mn && iso < mn) return false;
        if (mx && iso > mx) return false;
        return true;
      },
      setIso: function (iso) {
        var cur = NATIVE_VALUE.get.call(native);
        NATIVE_VALUE.set.call(native, iso || '');
        disp.value = fmt(NATIVE_VALUE.get.call(native));
        if (cur !== (NATIVE_VALUE.get.call(native) || '')) {
          native.dispatchEvent(new Event('input', { bubbles: true }));
          native.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    };

    disp.value = fmt(NATIVE_VALUE.get.call(native));

    // โค้ดเดิมที่สั่ง el.value = '2026-09-08' ตรงๆ ต้องอัปเดตช่องที่มองเห็นด้วย
    Object.defineProperty(native, 'value', {
      configurable: true,
      enumerable: true,
      get: function () { return NATIVE_VALUE.get.call(this); },
      set: function (v) {
        NATIVE_VALUE.set.call(this, v);
        disp.value = fmt(NATIVE_VALUE.get.call(this));
      }
    });

    disp.addEventListener('input', function () {
      var next = autoSlash(disp.value);
      if (next !== disp.value) disp.value = next;
      var iso = parse(disp.value);
      if (iso && !ctl.inRange(iso)) iso = null;
      var cur = NATIVE_VALUE.get.call(native) || '';
      var val = iso || '';
      if (cur !== val) {
        NATIVE_VALUE.set.call(native, val);
        native.dispatchEvent(new Event('input', { bubbles: true }));
        native.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (popTarget === ctl && iso) {
        popYear = parseInt(iso.slice(0, 4), 10);
        popMonth = parseInt(iso.slice(5, 7), 10);
        renderPop();
      }
    });

    // ออกจากช่องแล้วให้ข้อความตรงกับค่าที่บันทึกจริงเสมอ (พิมพ์ค้างครึ่งๆ กลางๆ หรือวันที่ไม่มีจริง
    // จะถูกคืนกลับเป็นค่าเดิม ไม่ปล่อยให้เห็นข้อความที่ระบบไม่ได้เก็บไว้จริง)
    disp.addEventListener('blur', function () {
      disp.value = fmt(NATIVE_VALUE.get.call(native));
    });

    // form.reset() ตั้งค่าช่องกลับเป็นค่า default โดยไม่ผ่าน property setter ด้านบน
    // ต้องซิงก์ข้อความที่มองเห็นเองอีกที (ทำหลัง reset ทำงานเสร็จ)
    if (native.form) {
      native.form.addEventListener('reset', function () {
        setTimeout(function () { disp.value = fmt(NATIVE_VALUE.get.call(native)); }, 0);
      });
    }

    disp.addEventListener('click', function () { if (!disp.disabled && !disp.readOnly) openPop(ctl); });
    disp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closePop();
      if (ev.key === 'Enter') { closePop(); }
    });
  }

  function enhance(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var list = scope.querySelectorAll('input[type="date"]:not([data-dcdate])');
    for (var i = 0; i < list.length; i++) wire(list[i]);
  }

  window.DCDate = { fmt: fmt, parse: parse, autoSlash: autoSlash, enhance: enhance, close: closePop };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { enhance(document); });
  } else {
    enhance(document);
  }
})();
