// Supabase Edge Function: flowaccount-gas-webhook
//
// Webhook endpoint for the "น้องบัญชี" LINE bot (Google Apps Script). GAS
// cannot present a Supabase user JWT, so this function is deployed with
// verify_jwt=false and instead checks a distinct shared secret
// (GAS_SHARED_SECRET) on every request — a SEPARATE secret from anything
// else in the project. Never reuse SUPABASE_SERVICE_ROLE_KEY here, and
// never reuse the LINE bot's existing WEBHOOK_SECRET_KEY (Code.gs' SECRET_())
// either — a leak of that one would also let someone forge LINE webhook
// events, which is a bigger blast radius than this endpoint should share.
//
//   - action "confirm_payment_from_slip":
//     body { shared_secret, client_id, year, month, ocr_amount }
//     Looks up the crm_invoices row for (client_id, year, month) and
//     compares ocr_amount against that row's expected_payment, ±20 บาท
//     tolerance (per the original design doc's usage notes — this margin
//     is intentional, to absorb Gemini Vision OCR misreads; don't change
//     it without re-confirming with the project owner).
//       - Within tolerance: marks the invoice paid, best-effort issues +
//         emails a FlowAccount receipt (a failure here does NOT undo the
//         "paid" status — payment having arrived is real regardless of
//         whether the receipt email succeeded, and it's retriable later
//         via flowaccount-sync's create_receipt_and_email action), marks
//         crm_tax_tasks.acct_fee 'done' for the same (client_id, year,
//         month) via the same upsert-by-(client_id,year,month) pattern the
//         CRM UI itself already uses, and returns { matched: true, ... }.
//       - Outside tolerance: changes NOTHING in the database and returns
//         { matched: false, expected, received } so the GAS side can alert
//         an admin room instead of guessing — this is the deliberate
//         mismatch fallback from the original design; kept intact here.
//       - Already-paid invoice (e.g. GAS retried the same slip after a
//         timeout, or the same slip got OCR'd twice): returns
//         { matched: true, already_paid: true, ... } WITHOUT re-issuing a
//         second FlowAccount receipt or re-touching crm_tax_tasks. This
//         idempotency guard is not explicitly spelled out in the original
//         design doc but is added here deliberately — without it, a
//         retried webhook call could email a client two receipts for the
//         same invoice.
//
// FlowAccount sandbox credentials come from Deno.env.get("FLOWACCOUNT_CLIENT_ID")
// / ("FLOWACCOUNT_CLIENT_SECRET") — the same two secrets as flowaccount-sync
// (set once in this project, used by both functions). The receipt-issuing
// FlowAccount call code below is intentionally a self-contained
// implementation in THIS file rather than imported from flowaccount-sync —
// the two functions have different trust models (staff JWT vs. shared
// secret) and are meant to stay independently deployable, per project
// convention (see the main flowaccount-sync/index.ts header). If you change
// a FlowAccount field-name assumption on one side, mirror it by hand on the
// other — the two implementations are meant to stay behaviorally identical.
//
// ⚠️ FlowAccount field names here carry the same "assumed, not fully
// confirmed against live docs" caveat as flowaccount-sync — see comments
// on buildReceiptPayload_ / issueFlowAccountReceipt_ below.
//
// Deploy via the Supabase Dashboard: Edge Functions → Create a function
// → name it "flowaccount-gas-webhook" → make sure "Verify JWT" is turned
// OFF (this function must be verify_jwt=false, since GAS cannot send a
// Supabase user JWT) → paste this file's contents → Deploy. Then add
// secrets FLOWACCOUNT_CLIENT_ID, FLOWACCOUNT_CLIENT_SECRET, and
// GAS_SHARED_SECRET (generate a long random string for the last one, and
// store that exact same value in the GAS project via PropertiesService,
// the same way WEBHOOK_SECRET_KEY is already stored there — see Code.gs).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Sandbox only — see flowaccount-sync/index.ts header for the same caveats
// (confirmed token URL; ASSUMED that resource paths hang off this "/test"
// prefix too). Do NOT swap either for a guessed production URL.
const FLOWACCOUNT_TOKEN_URL = "https://openapi.flowaccount.com/test/token";
const FLOWACCOUNT_SANDBOX_BASE = "https://openapi.flowaccount.com/test";

// บาท — ตามที่ระบุไว้ใน design doc เดิม (supabase-crm-billing-migration.sql
// USAGE NOTES: "match ยอด (fee*0.97 ±20 บาท)") ห้ามเปลี่ยนค่านี้โดยไม่ปรึกษา
// เจ้าของระบบก่อน เพราะเป็นระยะขอบที่กันความคลาดเคลื่อนของ OCR ไว้แล้ว
const PAYMENT_TOLERANCE_BAHT = 20;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

type FaResult<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

// See flowaccount-sync/index.ts's flowAccountToken_ for the full assumption
// notes (form-encoded OAuth2 client_credentials request, top-level
// access_token response field).
async function flowAccountToken_(): Promise<FaResult<string>> {
  const clientId = Deno.env.get("FLOWACCOUNT_CLIENT_ID");
  const clientSecret = Deno.env.get("FLOWACCOUNT_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return { ok: false, error: "ยังไม่ได้ตั้งค่า FlowAccount API (ขาด FLOWACCOUNT_CLIENT_ID / FLOWACCOUNT_CLIENT_SECRET)" };
  }
  let res: Response;
  try {
    res = await fetch(FLOWACCOUNT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch (e) {
    return { ok: false, error: `เชื่อมต่อ FlowAccount ไม่สำเร็จ: ${String((e as Error)?.message || e)}` };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    return { ok: false, error: `ขอ token จาก FlowAccount ไม่สำเร็จ (HTTP ${res.status})`, status: 502 };
  }
  return { ok: true, data: data.access_token as string };
}

async function faPost_(token: string, path: string, body: unknown): Promise<FaResult<any>> {
  let res: Response;
  try {
    res = await fetch(`${FLOWACCOUNT_SANDBOX_BASE}${path}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `เรียก FlowAccount ${path} ไม่สำเร็จ: ${String((e as Error)?.message || e)}` };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, error: `FlowAccount ${path} ตอบกลับผิดพลาด (HTTP ${res.status}): ${data ? JSON.stringify(data) : ""}`, status: 502 };
  }
  return { ok: true, data };
}

// ASSUMED shape — intentionally kept identical to buildReceiptPayload_ in
// flowaccount-sync/index.ts. See that file's comment for the full caveat.
function buildReceiptPayload_(client: any, invoice: any) {
  const periodLabel = `${TH_MONTHS[invoice.month] || invoice.month} ${invoice.year + 543}`;
  const amount = invoice.payment_amount ?? invoice.expected_payment;
  const payload: Record<string, unknown> = {
    customer: {
      name: client.thai_name || client.eng_name || client.code,
      tax_id: client.tax_number || "",
      branch: client.branch || "สำนักงานใหญ่",
      address: client.address || "",
      email: client.client_email || "",
    },
    issue_date: new Date().toISOString().slice(0, 10),
    items: [
      { description: `ค่าบริการทำบัญชี ประจำเดือน${periodLabel}`, quantity: 1, unit_price: amount, amount },
    ],
    notes: `รหัสลูกค้า ${client.code}`,
  };
  if (invoice.fa_invoice_id) payload.reference_invoice_id = invoice.fa_invoice_id;
  return payload;
}

// Confirmed 2-step flow from the design doc: POST /receipts (returns a
// document_id) → POST /receipts/email-document (references that
// document_id). Factored into its own function — per project convention —
// so the one call site below (confirm_payment_from_slip's matched branch)
// doesn't inline raw fetch calls; mirrors flowaccount-sync's
// issueFlowAccountReceipt_ behaviorally, kept as an independent
// implementation in this file on purpose (see file header: separate trust
// boundaries, independently deployable).
async function issueFlowAccountReceipt_(client: any, invoice: any): Promise<
  FaResult<{ fa_receipt_id: string; fa_receipt_no: string; fa_raw_response: unknown }>
> {
  const tokenResult = await flowAccountToken_();
  if (!tokenResult.ok) return tokenResult;

  const createResult = await faPost_(tokenResult.data, "/receipts", buildReceiptPayload_(client, invoice));
  if (!createResult.ok) return createResult;

  const documentId = String(createResult.data?.document_id ?? createResult.data?.id ?? "");
  const documentNo = String(createResult.data?.document_no ?? createResult.data?.doc_no ?? createResult.data?.receipt_no ?? "");
  if (!documentId) {
    return { ok: false, error: "FlowAccount สร้างใบเสร็จสำเร็จ แต่ไม่พบ document_id ในผลลัพธ์ (รูปแบบคำตอบอาจไม่ตรงกับที่คาดไว้)" };
  }

  const emailResult = await faPost_(tokenResult.data, "/receipts/email-document", {
    document_id: documentId,
    email: client.client_email, // ASSUMED field name
  });
  if (!emailResult.ok) {
    return { ok: false, error: `สร้างใบเสร็จสำเร็จ (เลขที่ ${documentNo || documentId}) แต่ส่งอีเมลไม่สำเร็จ: ${emailResult.error}` };
  }

  return {
    ok: true,
    data: { fa_receipt_id: documentId, fa_receipt_no: documentNo, fa_raw_response: { create: createResult.data, email: emailResult.data } },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const body = await req.json();

    // Shared-secret check FIRST — this function is verify_jwt=false (GAS
    // can't present a Supabase user JWT), so this is the only gate there
    // is. Must be its own distinct secret (GAS_SHARED_SECRET) — never
    // SUPABASE_SERVICE_ROLE_KEY, never the LINE bot's existing
    // WEBHOOK_SECRET_KEY. See file header.
    const expectedSecret = Deno.env.get("GAS_SHARED_SECRET");
    if (!expectedSecret) return json({ error: "ยังไม่ได้ตั้งค่า GAS_SHARED_SECRET ฝั่ง Supabase" }, 401);
    if (String(body.shared_secret || "") !== expectedSecret) return json({ error: "shared_secret ไม่ถูกต้อง" }, 401);

    const action = body.action;

    if (action === "confirm_payment_from_slip") {
      const clientId = body.client_id;
      const year = Number(body.year);
      const month = Number(body.month);
      const ocrAmount = Number(body.ocr_amount);
      if (!clientId) return json({ error: "ไม่พบ client_id" }, 400);
      if (!year || !month) return json({ error: "ไม่พบปี/เดือน (year, month)" }, 400);
      if (!Number.isFinite(ocrAmount)) return json({ error: "ocr_amount ไม่ถูกต้อง" }, 400);

      const { data: invoice, error: invErr } = await admin
        .from("crm_invoices").select("*")
        .eq("client_id", clientId).eq("year", year).eq("month", month)
        .maybeSingle();
      if (invErr) return json({ error: invErr.message }, 500);
      if (!invoice) return json({ matched: false, error: "ไม่พบใบแจ้งหนี้สำหรับลูกค้า/เดือนนี้" }, 404);

      // Idempotency guard (added deliberately, not from the original design
      // doc): a retried/duplicate slip for an already-paid invoice must not
      // re-issue a second FlowAccount receipt or re-touch crm_tax_tasks.
      if (invoice.status === "paid") {
        return json({
          matched: true, already_paid: true, invoice_id: invoice.id,
          fa_receipt_id: invoice.fa_receipt_id || null, fa_receipt_no: invoice.fa_receipt_no || null,
        });
      }

      const expected = Number(invoice.expected_payment) || 0;
      const diff = Math.abs(expected - ocrAmount);

      if (diff > PAYMENT_TOLERANCE_BAHT) {
        // ไม่ตรงตาม tolerance — ไม่แก้ไขอะไรในฐานข้อมูลทั้งสิ้น ปล่อยให้ฝั่ง
        // GAS ไปแจ้งเตือนห้อง admin แทนการเดาว่าใช่หรือไม่ใช่
        return json({ matched: false, invoice_id: invoice.id, expected, received: ocrAmount, diff });
      }

      const { data: client, error: cliErr } = await admin
        .from("crm_clients").select("*").eq("id", clientId).single();
      if (cliErr || !client) return json({ error: "ไม่พบข้อมูลลูกค้า" }, 404);

      const { data: paidInvoice, error: payErr } = await admin.from("crm_invoices")
        .update({ status: "paid", payment_received_at: new Date().toISOString(), payment_amount: ocrAmount })
        .eq("id", invoice.id).select().single();
      if (payErr) return json({ error: `บันทึกรับชำระไม่สำเร็จ: ${payErr.message}` }, 500);

      // ออกใบเสร็จ + ส่งอีเมล แบบ best-effort — ถ้าพลาด (เช่น ยังไม่ได้ตั้งค่า
      // FlowAccount API หรือลูกค้าไม่มีอีเมล) จะไม่ย้อนสถานะ "paid" กลับ
      // เพราะการยืนยันรับเงินคือข้อเท็จจริงที่เกิดขึ้นแล้ว ไม่ควรผูกกับว่า
      // อีเมลใบเสร็จออกได้หรือไม่ — ออกใบเสร็จซ้ำทีหลังได้ผ่าน
      // flowaccount-sync action create_receipt_and_email
      let receipt: { fa_receipt_id?: string; fa_receipt_no?: string; error?: string } = {};
      if (!client.client_email) {
        receipt = { error: "ลูกค้ารายนี้ไม่มีอีเมล ข้ามขั้นตอนออกใบเสร็จอัตโนมัติ" };
      } else {
        const issued = await issueFlowAccountReceipt_(client, paidInvoice);
        if (issued.ok) {
          await admin.from("crm_invoices").update({
            fa_receipt_id: issued.data.fa_receipt_id,
            fa_receipt_no: issued.data.fa_receipt_no,
            receipt_sent_at: new Date().toISOString(),
          }).eq("id", invoice.id);
          receipt = { fa_receipt_id: issued.data.fa_receipt_id, fa_receipt_no: issued.data.fa_receipt_no };
        } else {
          receipt = { error: issued.error };
        }
      }

      // อัปเดต crm_tax_tasks — ใช้ upsert ด้วย (client_id, year, month) แบบ
      // เดียวกับที่ confirmMarkPaid() ในหน้า CRM (crm/index.html) ทำอยู่แล้ว
      // ตอนติ๊ก "อัปเดต Acct Fee เป็นเสร็จแล้ว" หลังบันทึกรับเงินด้วยมือ
      const { error: taskErr } = await admin.from("crm_tax_tasks")
        .upsert(
          { client_id: clientId, year, month, acct_fee: "done", invoice_id: invoice.id },
          { onConflict: "client_id,year,month" },
        );

      return json({
        matched: true,
        invoice_id: invoice.id,
        expected,
        received: ocrAmount,
        receipt,
        tax_task_updated: !taskErr,
        tax_task_error: taskErr ? taskErr.message : undefined,
      });
    }

    return json({ error: "ไม่รู้จักคำสั่งนี้" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
