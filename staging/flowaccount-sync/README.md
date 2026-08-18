# flowaccount-sync (Edge Function)

Edge Function ที่พนักงานเรียกจากหน้า CRM เพื่อสร้างเอกสารจริงฝั่ง FlowAccount (ใบกำกับภาษี /
ใบเสร็จ) จากแถว `crm_invoices` — ต้อง login เป็นพนักงานจริงก่อนเรียก (`verify_jwt: true`,
เช็ค `crm_staff.role` แบบเดียวกับ `admin-staff`)

## Actions

- **`create_invoice`** — body `{ action: "create_invoice", invoice_id }`
  สิทธิ์: Owner/Senior เท่านั้น (ตาม RLS policy `crm_inv_ins`/`crm_inv_upd` เดิมของ `crm_invoices`)
  สร้างใบกำกับภาษีที่ FlowAccount แล้วบันทึก `fa_invoice_id`/`fa_invoice_no` กลับเข้า `crm_invoices`
  ไม่สร้างซ้ำถ้าแถวนั้นมี `fa_invoice_id` อยู่แล้ว

- **`create_receipt_and_email`** — body `{ action: "create_receipt_and_email", invoice_id }`
  สิทธิ์: Owner/Senior เท่านั้น ต้องมี `status = 'paid'` แล้วเท่านั้น (เช็คก่อนเรียก FlowAccount)
  และต้องมี `crm_clients.client_email` ไม่ว่าง — สร้างใบเสร็จที่ FlowAccount + ส่งอีเมลลูกค้า
  แล้วบันทึก `fa_receipt_id`/`fa_receipt_no`/`receipt_sent_at` กลับเข้า `crm_invoices`
  ไม่ออกซ้ำถ้าแถวนั้นมี `fa_receipt_id` อยู่แล้ว

ทั้งสอง action คืนค่า `fa_raw_response` (ผลตอบกลับดิบจาก FlowAccount) มาด้วยเสมอตอนสำเร็จ
เพื่อให้ตรวจสอบชื่อฟิลด์จริงจาก sandbox ได้ (ดูหัวข้อ "สิ่งที่ยังไม่ยืนยัน" ด้านล่าง)

## ENV ที่ต้องตั้งค่า (ยังไม่ได้ตั้ง — ฟังก์ชันจะ error แบบสุภาพจนกว่าจะตั้ง)

ตั้งผ่าน Supabase Dashboard → Edge Functions → `flowaccount-sync` → Secrets:

- `FLOWACCOUNT_CLIENT_ID`
- `FLOWACCOUNT_CLIENT_SECRET`

(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` มีให้อัตโนมัติอยู่แล้วทุก Edge Function)

## สิ่งที่ยังไม่ยืนยัน (ไม่ใช่ของแน่นอน — เดาจากเอกสารสรุปเท่าที่มี)

- **Base URL ของ endpoint เอกสาร** (`/tax-invoices`, `/receipts`, `/receipts/email-document`)
  สมมติว่าอยู่ใต้ prefix `/test` เดียวกับ token endpoint — ยืนยันจริงแล้วเฉพาะ URL token endpoint เท่านั้น
- **รูปแบบ body ตอนขอ token** — สมมติเป็น OAuth2 client_credentials แบบ form-urlencoded มาตรฐาน
  (อาจจริงๆ ต้องเป็น JSON หรือ Basic-Auth header แทนก็ได้)
- **ชื่อฟิลด์ใน payload** ของ `/tax-invoices` และ `/receipts` (เช่น `customer.name`, `items[].amount`,
  `withholding_tax_amount`) และชื่อฟิลด์ตอบกลับ (`document_id`, `document_no`) — เดาจากโครงสร้างทั่วไป
  ไม่ได้เทียบกับเอกสาร FlowAccount ตัวจริง
- **ชื่อฟิลด์อีเมลปลายทาง** ใน `/receipts/email-document` — สมมติว่าเป็น `email`

ก่อนใช้งานจริง ควรลองยิง action ทั้งสองตัวกับ sandbox จริงสักครั้ง แล้วดู `fa_raw_response`
เทียบกับที่คาดไว้ ถ้าไม่ตรงให้แก้เฉพาะ `buildTaxInvoicePayload_` / `buildReceiptPayload_` /
จุด parse response ใน `index.ts` (ไม่กระทบส่วนอื่น)

## Deploy

Deploy แล้วผ่าน Supabase MCP ไปยัง project "Web" (`dqegkyobclqqichhnxfm`) — ถ้าจะ deploy ทับเอง
ผ่าน Dashboard: Edge Functions → Create a function → ตั้งชื่อ `flowaccount-sync` → Verify JWT
เปิดไว้ (ค่า default) → วางโค้ดจาก `index.ts` → Deploy
