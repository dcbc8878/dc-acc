/* ============================================================================
   ธีมกลางของทั้งเว็บ (หน้ารวม + CRM + ปฏิทิน + พนักงาน/ทีม)
   ----------------------------------------------------------------------------
   ทั้ง 4 หน้าอยู่โดเมนเดียวกัน (same-origin) จึงใช้ localStorage ร่วมกันได้ และ
   event 'storage' ของเบราว์เซอร์จะยิงเข้า "ทุก document อื่น" ที่ origin เดียวกัน
   โดยอัตโนมัติเมื่อค่าถูกเปลี่ยน — รวมถึง iframe ที่ฝังอยู่ในหน้ารวมด้วย จึงไม่ต้อง
   สร้างช่องทาง postMessage ใหม่ให้เรื่องธีมโดยเฉพาะ

   สัญญาที่ทุกไฟล์ต้องใช้ให้ตรงกัน (ห้ามแก้ข้างเดียว):
     localStorage['dcacc_theme'] = {"brand":"#RRGGBB","mode":"light"|"dark"|"system"}
     - brand = สีหลักของแอพ ทุกโทเคนสีถูกคำนวณต่อจากสีนี้ด้วย color-mix(in oklab, ...)
               จึงเปลี่ยนสีเดียวแล้วเปลี่ยนทั้งแอพ (ตั้งเป็น --brand บน <html>)
     - mode  = โหมดสว่าง/มืด/ตามเครื่อง (ตั้งเป็น data-theme บน <html>)

   ต้องแทรกเป็น <script src="..."> ธรรมดาใน <head> (ห้ามใส่ defer/async) เพื่อให้
   ทำงานก่อนหน้าเว็บถูกวาดครั้งแรก ไม่งั้นจะเห็นธีมเดิมแวบหนึ่งก่อนเปลี่ยน
   ============================================================================ */
(function () {
  var KEY = 'dcacc_theme';
  var DEFAULT_BRAND = '#2F5D50';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    var v = {};
    try { v = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { v = {}; }
    var brand = (typeof v.brand === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.brand)) ? v.brand : DEFAULT_BRAND;
    var mode = (v.mode === 'dark' || v.mode === 'light' || v.mode === 'system') ? v.mode : 'system';
    return { brand: brand, mode: mode };
  }

  function resolved(mode) {
    return mode === 'system' ? ((mq && mq.matches) ? 'dark' : 'light') : mode;
  }

  // precomputed (optional): apply this exact {brand,mode} instead of re-reading
  // localStorage. Needed by set() below -- if localStorage.setItem() there just
  // failed (private-browsing mode with a zero write quota, cookies/site-data
  // disabled, storage full), read()-ing again right after would silently see
  // the OLD stored value and paint that instead, while notify() still
  // broadcasts the NEW value to every 'dctheme' listener (including this same
  // page's own theme picker, which would then show the new color as selected
  // even though the page's own --brand never actually changed). Every other
  // caller (the initial apply() call below, the storage-event and
  // prefers-color-scheme listeners further down) omits this argument on
  // purpose -- they exist specifically to pick up a value that changed
  // elsewhere, so they must keep re-reading fresh from storage.
  function apply(precomputed) {
    var t = precomputed || read(), r = document.documentElement;
    r.setAttribute('data-theme', resolved(t.mode));
    r.style.setProperty('--brand', t.brand);
    return t;
  }

  function notify(t) {
    try { window.dispatchEvent(new CustomEvent('dctheme', { detail: t })); } catch (e) {}
  }

  window.DCTheme = {
    KEY: KEY,
    DEFAULT_BRAND: DEFAULT_BRAND,
    read: read,
    resolved: resolved,
    apply: apply,
    /* set({brand}) / set({mode}) / set({brand,mode}) — เขียนลง localStorage แล้วทาสีทันที
       เอกสารอื่น (iframe พี่น้อง/แท็บอื่น) จะได้รับผ่าน event 'storage' เอง ไม่ต้องสั่งเพิ่ม
       ส่วนเอกสารที่เรียก set() เองจะไม่ได้ 'storage' (สเปกของเบราว์เซอร์) จึง apply+notify ตรงนี้ */
    set: function (patch) {
      var t = read();
      if (patch && typeof patch.brand === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.brand)) t.brand = patch.brand;
      if (patch && (patch.mode === 'dark' || patch.mode === 'light' || patch.mode === 'system')) t.mode = patch.mode;
      try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) {}
      apply(t);
      notify(t);
      return t;
    },
    reset: function () { return window.DCTheme.set({ brand: DEFAULT_BRAND, mode: 'system' }); }
  };

  apply();

  window.addEventListener('storage', function (e) {
    if (e.key === KEY) notify(apply());
  });

  if (mq) {
    var onSys = function () { if (read().mode === 'system') notify(apply()); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
    else if (mq.addListener) mq.addListener(onSys);
  }
})();
