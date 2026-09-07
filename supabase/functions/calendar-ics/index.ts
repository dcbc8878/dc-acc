// ลิงก์ iCal แบบสด (subscribe URL) สำหรับปฏิทิน DCBC
// เรียกแบบไม่ต้องล็อกอิน (โปรแกรมปฏิทินส่ง JWT ไม่ได้) — ตัวที่ใช้ยืนยันตัวตนคือ ?token= ซึ่งเป็นความลับ
// ส่วนตัวของแต่ละคน เก็บใน cal_ics_tokens (anon อ่านไม่ได้) แล้วให้ฟังก์ชัน cal_ics_feed() ในฐานข้อมูล
// เป็นตัวตัดสินว่าคนนั้นเห็นกิจกรรมแถวไหนได้บ้าง (คัดลอกเงื่อนไขมาจาก RLS ของ cal_events เป๊ะ)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TZID = "Asia/Bangkok";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// พับบรรทัดตามสเปก iCalendar (75 ออกเทต) — นับเป็น "ไบต์" ไม่ใช่ตัวอักษร เพราะภาษาไทยตัวหนึ่งกิน 3 ไบต์
// และห้ามตัดกลางตัวอักษร ไม่งั้น Google จะอ่านไฟล์ไม่ออก
function fold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ch;
      curBytes = n;
      limit = 74; // บรรทัดต่อเนื่องเสียไป 1 ไบต์ให้ช่องว่างนำหน้า
    } else {
      cur += ch;
      curBytes += n;
    }
  }
  if (cur) out.push(cur);
  return out.join("\r\n ");
}

const pad = (n: number) => String(n).padStart(2, "0");
const stampUTC = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
  `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

const ymd = (s: string) => String(s).slice(0, 10).replace(/-/g, "");

function nextDay(s: string): string {
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
}

function hhmmss(t: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ""));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${pad(h)}${pad(mi)}00`;
}

export function buildIcs(rows: Record<string, unknown>[]): string {
  const now = stampUTC(new Date());
  const L: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//DCBC//Calendar//TH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:DCBC ปฏิทิน",
    `X-WR-TIMEZONE:${TZID}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "BEGIN:VTIMEZONE",
    `TZID:${TZID}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0700",
    "TZOFFSETTO:+0700",
    "TZNAME:+07",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];

  for (const ev of rows) {
    const date = ev.date as string | null;
    if (!date) continue;
    L.push("BEGIN:VEVENT");
    L.push(`UID:${ev.id}@dcbc-calendar`);
    L.push(`DTSTAMP:${now}`);
    if (ev.updated_at) L.push(`LAST-MODIFIED:${stampUTC(new Date(String(ev.updated_at)))}`);

    const start = hhmmss(ev.time);
    if (ev.all_day === true || !start) {
      L.push(`DTSTART;VALUE=DATE:${ymd(date)}`);
      L.push(`DTEND;VALUE=DATE:${nextDay(date)}`); // สเปกกำหนดให้วันจบเป็นวันถัดไป (ไม่รวมวันนั้น)
    } else {
      L.push(`DTSTART;TZID=${TZID}:${ymd(date)}T${start}`);
      const end = hhmmss(ev.end_time);
      if (end && end > start) L.push(`DTEND;TZID=${TZID}:${ymd(date)}T${end}`);
      else L.push("DURATION:PT1H"); // ไม่ได้ระบุเวลาจบ ให้เป็น 1 ชั่วโมงตามค่ามาตรฐานทั่วไป
    }

    L.push(`SUMMARY:${esc(ev.title || "(ไม่มีชื่อ)")}`);
    if (ev.note) L.push(`DESCRIPTION:${esc(ev.note)}`);
    if (ev.client_name) L.push(`LOCATION:${esc(ev.client_name)}`);
    const cats: string[] = [];
    if (ev.category) cats.push(String(ev.category));
    if (ev.is_team === true) cats.push("ทีม");
    if (cats.length) L.push(`CATEGORIES:${cats.map(esc).join(",")}`);
    L.push("END:VEVENT");
  }

  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const token = new URL(req.url).searchParams.get("token") || "";
  if (!/^[0-9a-f]{32,128}$/.test(token)) {
    return new Response("ลิงก์ไม่ถูกต้อง", { status: 404, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await sb.rpc("cal_ics_feed", { p_token: token });
  if (error) {
    return new Response("เกิดข้อผิดพลาด", { status: 500, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (!data || data.length === 0) {
    // ไม่มีแถวเลย = ลิงก์ผิด/ถูกยกเลิกไปแล้ว หรือคนนั้นยังไม่มีนัดหมายเลยก็ได้ — คืนปฏิทินว่างเปล่า
    // ไม่ใช่ 404 เพื่อไม่ให้เดาได้ว่า token ไหนมีอยู่จริง และไม่ให้โปรแกรมปฏิทินขึ้น error ทุกครั้ง
    return new Response(buildIcs([]), {
      headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  }

  return new Response(buildIcs(data as Record<string, unknown>[]), {
    headers: {
      ...CORS,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="dcbc-calendar.ics"',
      "Cache-Control": "public, max-age=300",
    },
  });
});
