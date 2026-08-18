// Supabase Edge Function: flowaccount-sync
//
// Staff-triggered actions that create real FlowAccount documents (tax
// invoices, receipts) from the CRM's crm_invoices rows. Requires a real
// logged-in staff JWT — same trust model as admin-staff (never trust the
// client; the caller's crm_staff.role is re-checked server-side on every
// call using the caller's own JWT, then privileged reads/writes go through
// a service-role client).
//
//   - action "create_invoice":            body { invoice_id }
//     Owner/Senior only (matches crm_invoices' own crm_inv_ins/crm_inv_upd
//     RLS policies — crm_get_role() IN ('owner','senior') — reused here
//     rather than inventing a different tier). Creates a FlowAccount tax
//     invoice for the client/month on that crm_invoices row, then stores
//     fa_invoice_id / fa_invoice_no. Refuses to run twice on the same row
//     (won't create a second real document if fa_invoice_id already set).
//
//   - action "create_receipt_and_email":  body { invoice_id }
//     Owner/Senior only. Requires the invoice to already be status='paid'
//     and crm_clients.client_email to be non-empty. Creates a FlowAccount
//     receipt, emails it to the client, then stores fa_receipt_id /
//     fa_receipt_no / receipt_sent_at. Also refuses to run twice.
//
// FlowAccount sandbox credentials come from Deno.env.get("FLOWACCOUNT_CLIENT_ID")
// / ("FLOWACCOUNT_CLIENT_SECRET") — set these via Supabase Dashboard → Edge
// Functions → flowaccount-sync → Secrets (they do NOT exist yet as of this
// deploy). Until they're set, both actions fail closed with a clear Thai
// error instead of crashing.
//
// ⚠️ FlowAccount request/response field names below are only PARTIALLY
// confirmed against real docs — see the comments above
// buildTaxInvoicePayload_ / buildReceiptPayload_ / issueFlowAccountReceipt_.
// This function echoes FlowAccount's raw response back as fa_raw_response
// on success specifically so the field-name guesses can be checked against
// a real sandbox call and fixed here without needing extra logging infra.
//
// Deploy via the Supabase Dashboard: Edge Functions → Create a function
// → name it "flowaccount-sync" → paste this file's contents → Deploy
// (Verify JWT should stay ON — this function requires a real staff login).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are automatically available;
// FLOWACCOUNT_CLIENT_ID / FLOWACCOUNT_CLIENT_SECRET must be added manually.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Sandbox only — confirmed exact URL from the design doc. Do NOT swap this
// for a guessed production endpoint; FlowAccount's production token URL is
// not confirmed anywhere in this project yet. Leave a comment (like this
// one) rather than inventing one if that's ever needed.
const FLOWACCOUNT_TOKEN_URL = "https://openapi.flowaccount.com/test/token";
// ASSUMED: the design doc only confirms the *relative* paths "/tax-invoices",
// "/receipts", "/receipts/email-document" — it does not say whether they
// hang off this same "/test" sandbox prefix. Assumed here because it
// mirrors the token endpoint's own "/test" prefix. Verify against a real
// sandbox call before trusting this blindly.
const FLOWACCOUNT_SANDBOX_BASE = "https://openapi.flowaccount.com/test";

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

// Fetches a sandbox Bearer token via OAuth2 client_credentials.
// ASSUMED request shape: standard OAuth2 client_credentials grant sent as
// an application/x-www-form-urlencoded body (RFC 6749 §4.4.2) — the design
// doc confirms only "OAuth2 client_credentials" + the URL, not whether
// FlowAccount wants form-encoded vs JSON, or Basic-Auth instead of body
// params. ASSUMED response shape: a top-level `access_token` field.
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

// Generic authenticated POST to a FlowAccount sandbox endpoint.
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

// ASSUMED FlowAccount tax-invoice payload shape. Confirmed from the design
// doc: POST /tax-invoices needs full customer info (not a Contact ID
// reference) + line items, every call. Field names (customer.*, items[].*,
// withholding_tax_amount/rate) are a best-effort guess grounded only in
// crm_clients/crm_invoices' own confirmed columns — NOT confirmed against
// live FlowAccount API docs. Verify against fa_raw_response from a real
// sandbox call before relying on this.
function buildTaxInvoicePayload_(client: any, invoice: any) {
  const periodLabel = `${TH_MONTHS[invoice.month] || invoice.month} ${invoice.year + 543}`;
  const payload: Record<string, unknown> = {
    customer: {
      name: client.thai_name || client.eng_name || client.code,
      tax_id: client.tax_number || "",
      branch: client.branch || "สำนักงานใหญ่",
      address: client.address || "",
      email: client.client_email || "",
    },
    issue_date: new Date().toISOString().slice(0, 10), // Gregorian ISO for the API — พ.ศ. is only used in the Thai display text below
    items: [
      {
        description: `ค่าบริการทำบัญชี ประจำเดือน${periodLabel}`,
        quantity: 1,
        unit_price: invoice.fee_amount,
        amount: invoice.fee_amount,
      },
    ],
    notes: `รหัสลูกค้า ${client.code}`,
  };
  // crm_invoices.fee_amount is the full (gross) fee; wht_amount is the
  // deduction that reduces what's actually collected — represented here as
  // a separate withholding field alongside the full line-item amount,
  // mirroring how crm_invoices itself models fee_amount vs wht_amount vs
  // expected_payment (fee - wht) as three distinct columns.
  if (client.has_wht && Number(invoice.wht_amount) > 0) {
    payload.withholding_tax_amount = invoice.wht_amount; // ASSUMED field name
    payload.withholding_tax_rate = 3; // ASSUMED field name — 3% per has_wht flag
  }
  return payload;
}

// ASSUMED FlowAccount receipt payload shape — same caveat as
// buildTaxInvoicePayload_ above.
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
  if (invoice.fa_invoice_id) payload.reference_invoice_id = invoice.fa_invoice_id; // ASSUMED field name, only sent if a tax invoice was created earlier
  return payload;
}

// Confirmed 2-step flow from the design doc: POST /receipts (returns a
// document_id) → POST /receipts/email-document (references that
// document_id to email the customer). The email destination field name on
// the second call is ASSUMED as "email". Factored into one function since
// this exact sequence is also what flowaccount-gas-webhook needs to run
// internally after a matched payment slip — kept as an independent
// implementation there rather than imported from here (see that file's
// header comment for why: separate trust boundaries, independently
// deployable, per project convention). Keep the two in sync by hand if you
// change field-name assumptions on either side.
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
    return { ok: false, error: "FlowAccount สร้างใบเสร็จสำเร็จ แต่ไม่พบ document_id ในผลลัพธ์ (รูปแบบคำตอบอาจไม่ตรงกับที่คาดไว้ — ดู fa_raw_response)" };
  }

  const emailResult = await faPost_(tokenResult.data, "/receipts/email-document", {
    document_id: documentId,
    email: client.client_email, // ASSUMED field name
  });
  if (!emailResult.ok) {
    // Receipt exists in FlowAccount but the email step failed — surface
    // this clearly rather than reporting a clean success, since the caller
    // (and the DB) should NOT record fa_receipt_id/receipt_sent_at as if
    // the client actually received it.
    return { ok: false, error: `สร้างใบเสร็จสำเร็จ (เลขที่ ${documentNo || documentId}) แต่ส่งอีเมลไม่สำเร็จ: ${emailResult.error}` };
  }

  return {
    ok: true,
    data: {
      fa_receipt_id: documentId,
      fa_receipt_no: documentNo,
      fa_raw_response: { create: createResult.data, email: emailResult.data },
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ error: "ไม่ได้เข้าสู่ระบบ" }, 401);

    const { data: callerStaff } = await admin
      .from("crm_staff").select("role, is_active").eq("id", caller.id).single();
    if (!callerStaff?.is_active) return json({ error: "บัญชีถูกปิดใช้งาน" }, 403);

    const body = await req.json();
    const action = body.action;

    // Both actions share the same authorization tier as crm_invoices' own
    // crm_inv_ins / crm_inv_upd RLS policies (crm_get_role() IN
    // ('owner','senior')) — reused here rather than inventing a new tier.
    if (action === "create_invoice" || action === "create_receipt_and_email") {
      if (!["owner", "senior"].includes(callerStaff.role)) {
        return json({ error: "ไม่มีสิทธิ์ทำรายการนี้ (ต้องเป็น Owner หรือ Senior)" }, 403);
      }
    }

    if (action === "create_invoice") {
      const invoiceId = body.invoice_id;
      if (!invoiceId) return json({ error: "ไม่พบ invoice_id" }, 400);

      const { data: invoice, error: invErr } = await admin
        .from("crm_invoices").select("*").eq("id", invoiceId).single();
      if (invErr || !invoice) return json({ error: "ไม่พบใบแจ้งหนี้นี้" }, 404);
      if (invoice.fa_invoice_id) {
        return json({ error: `ใบแจ้งหนี้นี้มีเลขที่ FlowAccount อยู่แล้ว (${invoice.fa_invoice_no || invoice.fa_invoice_id}) — ไม่สร้างซ้ำ` }, 400);
      }

      const { data: client, error: cliErr } = await admin
        .from("crm_clients").select("*").eq("id", invoice.client_id).single();
      if (cliErr || !client) return json({ error: "ไม่พบข้อมูลลูกค้า" }, 404);

      const tokenResult = await flowAccountToken_();
      if (!tokenResult.ok) return json({ error: tokenResult.error }, tokenResult.status || 400);

      const faResult = await faPost_(tokenResult.data, "/tax-invoices", buildTaxInvoicePayload_(client, invoice));
      if (!faResult.ok) return json({ error: faResult.error }, faResult.status || 502);

      const faInvoiceId = String(faResult.data?.document_id ?? faResult.data?.id ?? "");
      const faInvoiceNo = String(faResult.data?.document_no ?? faResult.data?.doc_no ?? faResult.data?.invoice_no ?? "");

      const { data: updated, error: updErr } = await admin.from("crm_invoices")
        .update({ fa_invoice_id: faInvoiceId, fa_invoice_no: faInvoiceNo })
        .eq("id", invoiceId).select().single();
      if (updErr) {
        return json({
          error: `สร้างใบกำกับภาษีที่ FlowAccount สำเร็จ แต่บันทึกลงฐานข้อมูลไม่สำเร็จ: ${updErr.message}`,
          fa_invoice_id: faInvoiceId, fa_invoice_no: faInvoiceNo,
        }, 500);
      }

      return json({ ok: true, invoice: updated, fa_invoice_id: faInvoiceId, fa_invoice_no: faInvoiceNo, fa_raw_response: faResult.data });
    }

    if (action === "create_receipt_and_email") {
      const invoiceId = body.invoice_id;
      if (!invoiceId) return json({ error: "ไม่พบ invoice_id" }, 400);

      const { data: invoice, error: invErr } = await admin
        .from("crm_invoices").select("*").eq("id", invoiceId).single();
      if (invErr || !invoice) return json({ error: "ไม่พบใบแจ้งหนี้นี้" }, 404);
      if (invoice.status !== "paid") {
        return json({ error: "ใบแจ้งหนี้นี้ยังไม่ได้บันทึกว่ารับชำระแล้ว (status ไม่ใช่ paid) จึงยังออกใบเสร็จไม่ได้" }, 400);
      }
      if (invoice.fa_receipt_id) {
        return json({ error: `ใบแจ้งหนี้นี้ออกใบเสร็จไปแล้ว (เลขที่ ${invoice.fa_receipt_no || invoice.fa_receipt_id}) — ไม่ออกซ้ำ` }, 400);
      }

      const { data: client, error: cliErr } = await admin
        .from("crm_clients").select("*").eq("id", invoice.client_id).single();
      if (cliErr || !client) return json({ error: "ไม่พบข้อมูลลูกค้า" }, 404);
      if (!client.client_email) return json({ error: "ลูกค้ารายนี้ยังไม่มีอีเมลสำหรับส่งใบเสร็จ (client_email ว่าง)" }, 400);

      const issued = await issueFlowAccountReceipt_(client, invoice);
      if (!issued.ok) return json({ error: issued.error }, issued.status || 502);

      const { data: updated, error: updErr } = await admin.from("crm_invoices")
        .update({
          fa_receipt_id: issued.data.fa_receipt_id,
          fa_receipt_no: issued.data.fa_receipt_no,
          receipt_sent_at: new Date().toISOString(),
        })
        .eq("id", invoiceId).select().single();
      if (updErr) {
        return json({
          error: `ออกใบเสร็จและส่งอีเมลสำเร็จ แต่บันทึกลงฐานข้อมูลไม่สำเร็จ: ${updErr.message}`,
          fa_receipt_id: issued.data.fa_receipt_id, fa_receipt_no: issued.data.fa_receipt_no,
        }, 500);
      }

      return json({
        ok: true,
        invoice: updated,
        fa_receipt_id: issued.data.fa_receipt_id,
        fa_receipt_no: issued.data.fa_receipt_no,
        fa_raw_response: issued.data.fa_raw_response,
      });
    }

    return json({ error: "ไม่รู้จักคำสั่งนี้" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
