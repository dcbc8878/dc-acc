// Supabase Edge Function: admin-staff
//
// Handles the actions that require the service-role key (never exposed
// to the browser):
//   - action "create":      make a new auth user + crm_staff row, default
//     password "123456", must_change_password = true (LV1-3 only)
//   - action "reset":       reset an existing staff member's password back
//     to "123456" and set must_change_password = true (LV1-2 only)
//   - action "self_update": let ANY active staff member change their own
//     username (auth email), display name, nickname, and/or birthdate —
//     always targets the caller's own account, never a target id from
//     the body
//   - action "approve_request": turn a pending crm_staff_requests row
//     into a real auth user + crm_staff row (LV1-2 only) — the only way
//     a request can ever reach status "approved", since crm_staff_requests'
//     own RLS blocks the client from setting that status directly (only
//     this service-role path can actually create the matching auth user)
//
// All actions re-check the caller's role/identity server-side (never
// trust the client) using the caller's own JWT.
//
// Deploy via the Supabase Dashboard: Edge Functions → Create a function
// → name it "admin-staff" → paste this file's contents → Deploy.
// No secrets to configure — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
// are automatically available to every Edge Function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STAFF_EMAIL_DOMAIN = "staff.dcbc.co.th";
const DEFAULT_PASSWORD = "123456";

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

    if (action === "create") {
      if (!["owner", "manager", "senior"].includes(callerStaff.role)) {
        return json({ error: "ไม่มีสิทธิ์เพิ่มพนักงาน (ต้องเป็น LV1-3)" }, 403);
      }
      const username = String(body.username || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
      const displayName = String(body.display_name || "").trim();
      const role = String(body.role || "junior");
      if (!username) return json({ error: "กรุณากรอกชื่อผู้ใช้" }, 400);
      if (!displayName) return json({ error: "กรุณากรอกชื่อแสดง" }, 400);
      if (!["owner", "manager", "senior", "junior", "parttime"].includes(role)) {
        return json({ error: "สิทธิ์ไม่ถูกต้อง" }, 400);
      }
      // Only owner/manager may create an owner or manager account.
      if (["owner", "manager"].includes(role) && !["owner", "manager"].includes(callerStaff.role)) {
        return json({ error: "ไม่มีสิทธิ์ตั้งค่าระดับนี้" }, 403);
      }

      const email = `${username}@${STAFF_EMAIL_DOMAIN}`;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password: DEFAULT_PASSWORD, email_confirm: true,
      });
      if (createErr || !created?.user) {
        return json({ error: createErr?.message || "สร้างบัญชีไม่สำเร็จ" }, 400);
      }

      const { error: insertErr } = await admin.from("crm_staff").insert({
        id: created.user.id, display_name: displayName, role,
        is_active: true, must_change_password: true,
      });
      if (insertErr) {
        await admin.auth.admin.deleteUser(created.user.id); // roll back the auth user
        return json({ error: insertErr.message }, 400);
      }

      return json({ ok: true, username, default_password: DEFAULT_PASSWORD });
    }

    if (action === "reset") {
      if (!["owner", "manager"].includes(callerStaff.role)) {
        return json({ error: "ไม่มีสิทธิ์รีเซ็ทรหัสผ่าน (ต้องเป็น LV1-2)" }, 403);
      }
      const staffId = String(body.staff_id || "");
      if (!staffId) return json({ error: "ไม่พบพนักงาน" }, 400);

      const { error: updErr } = await admin.auth.admin.updateUserById(staffId, {
        password: DEFAULT_PASSWORD,
      });
      if (updErr) return json({ error: updErr.message }, 400);

      await admin.from("crm_staff").update({ must_change_password: true }).eq("id", staffId);
      return json({ ok: true, default_password: DEFAULT_PASSWORD });
    }

    if (action === "self_update") {
      // Any active staff member may update their OWN display name /
      // nickname / birthdate / username (auth email). Always targets
      // caller.id — never a target id from the request body — so this
      // can never be used to modify someone else's account.
      const displayName = body.display_name != null ? String(body.display_name).trim() : undefined;
      const nickname = body.nickname != null ? String(body.nickname).trim() : undefined;
      const birthdate = body.birthdate != null ? String(body.birthdate).trim() : undefined;
      const usernameRaw = body.username != null ? String(body.username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "") : undefined;

      if (usernameRaw !== undefined) {
        if (!usernameRaw) return json({ error: "กรุณากรอกชื่อผู้ใช้" }, 400);
        const newEmail = `${usernameRaw}@${STAFF_EMAIL_DOMAIN}`;
        const { error: emailErr } = await admin.auth.admin.updateUserById(caller.id, {
          email: newEmail, email_confirm: true,
        });
        if (emailErr) {
          const msg = /already|exists|registered/i.test(emailErr.message)
            ? "ชื่อผู้ใช้นี้ถูกใช้แล้ว" : emailErr.message;
          return json({ error: msg }, 400);
        }
      }

      const staffFields: Record<string, unknown> = {};
      if (displayName !== undefined) {
        if (!displayName) return json({ error: "กรุณากรอกชื่อ-นามสกุล" }, 400);
        staffFields.display_name = displayName;
      }
      if (nickname !== undefined) staffFields.nickname = nickname;
      if (birthdate !== undefined) staffFields.birthdate = birthdate || null;

      if (Object.keys(staffFields).length) {
        const { error: profErr } = await admin.from("crm_staff").update(staffFields).eq("id", caller.id);
        if (profErr) return json({ error: profErr.message }, 400);
      }

      return json({ ok: true });
    }

    if (action === "approve_request") {
      // LV1-2 only. Turns a pending crm_staff_requests row into a real
      // auth user + crm_staff row, reusing the exact same
      // must_change_password / default-password first-login mechanism
      // as action "create". This is the ONLY path that can ever set a
      // request's status to "approved" — crm_staff_requests' own RLS
      // deliberately blocks that from the client, since only the
      // service role can actually create the auth user behind it.
      if (!["owner", "manager"].includes(callerStaff.role)) {
        return json({ error: "ไม่มีสิทธิ์อนุมัติคำขอสมัคร (ต้องเป็น LV1-2)" }, 403);
      }
      const requestId = body.request_id;
      if (!requestId) return json({ error: "ไม่พบคำขอ" }, 400);

      const { data: reqRow, error: reqErr } = await admin
        .from("crm_staff_requests").select("*").eq("id", requestId).single();
      if (reqErr || !reqRow) return json({ error: "ไม่พบคำขอ" }, 400);
      if (reqRow.status !== "pending") return json({ error: "คำขอนี้ถูกดำเนินการไปแล้ว" }, 400);

      const username = String(body.username || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
      const role = String(body.role || "junior");
      const staffCode = String(body.staff_code || "").trim().toUpperCase();
      if (!username) return json({ error: "กรุณากำหนดชื่อผู้ใช้" }, 400);
      if (!staffCode) return json({ error: "กรุณากำหนดรหัสพนักงาน" }, 400);
      if (!["owner", "manager", "senior", "junior", "parttime"].includes(role)) {
        return json({ error: "สิทธิ์ไม่ถูกต้อง" }, 400);
      }
      // Same role-ceiling rule as "create": only owner/manager may approve
      // someone into an owner or manager account.
      if (["owner", "manager"].includes(role) && !["owner", "manager"].includes(callerStaff.role)) {
        return json({ error: "ไม่มีสิทธิ์ตั้งค่าระดับนี้" }, 403);
      }

      const email = `${username}@${STAFF_EMAIL_DOMAIN}`;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email, password: DEFAULT_PASSWORD, email_confirm: true,
      });
      if (createErr || !created?.user) {
        const msg = /already|exists|registered/i.test(createErr?.message || "")
          ? "ชื่อผู้ใช้นี้ถูกใช้แล้ว" : (createErr?.message || "สร้างบัญชีไม่สำเร็จ");
        return json({ error: msg }, 400);
      }

      const displayName = `${reqRow.prefix || ""}${reqRow.first_name} ${reqRow.last_name}`.trim();
      const { error: insertErr } = await admin.from("crm_staff").insert({
        id: created.user.id, display_name: displayName, nickname: reqRow.nickname || "",
        role, staff_code: staffCode, is_active: true, must_change_password: true,
        birthdate: reqRow.birthdate,
      });
      if (insertErr) {
        await admin.auth.admin.deleteUser(created.user.id); // roll back the auth user
        const msg = /duplicate|unique/i.test(insertErr.message) ? "รหัสพนักงานนี้ถูกใช้แล้ว" : insertErr.message;
        return json({ error: msg }, 400);
      }
      // Sensitive fields (tax_id/id_card_address/personal_email) live in
      // crm_staff_private, not crm_staff — crm_staff_sel lets any active
      // colleague read a full crm_staff row, but crm_staff_private is
      // locked to the person themselves or LV1-2 only.
      await admin.from("crm_staff_private").insert({
        id: created.user.id, tax_id: reqRow.tax_id,
        id_card_address: reqRow.id_card_address, personal_email: reqRow.personal_email,
      });

      await admin.from("crm_staff_requests").update({
        status: "approved", role, staff_code: staffCode, assigned_username: username,
        new_staff_id: created.user.id, approved_by: caller.id, approved_at: new Date().toISOString(),
      }).eq("id", requestId);

      return json({ ok: true, username, default_password: DEFAULT_PASSWORD });
    }

    return json({ error: "ไม่รู้จักคำสั่งนี้" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
