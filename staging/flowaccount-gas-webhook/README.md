# flowaccount-gas-webhook (Edge Function)

Edge Function ที่ฝั่ง Google Apps Script ("น้องบัญชี" LINE bot) เรียกเข้ามาหลัง OCR สลิปโอนเงิน
ของลูกค้าด้วย Gemini Vision แล้ว — GAS ไม่มี Supabase user JWT ให้ใช้ จึง deploy แบบ
**`verify_jwt: false`** และเช็คสิทธิ์ด้วย shared secret ของตัวเอง (`GAS_SHARED_SECRET`) แทน
คนละตัวกับ `WEBHOOK_SECRET_KEY` เดิมที่ LINE bot ใช้เปิด webhook ของตัวเอง (`Code.gs` → `SECRET_()`)
และคนละตัวกับ `SUPABASE_SERVICE_ROLE_KEY` — ห้ามใช้ซ้ำกันทั้งคู่

## Action

- **`confirm_payment_from_slip`** — body:
  ```json
  { "shared_secret": "...", "client_id": 1, "year": 2026, "month": 8, "ocr_amount": 12000 }
  ```
  1. เช็ค `shared_secret` ก่อนเสมอ (401 ถ้าไม่ตรง/ยังไม่ได้ตั้งค่า)
  2. หาแถว `crm_invoices` ที่ `(client_id, year, month)` ตรงกัน
  3. ถ้าแถวนั้น `status = 'paid'` อยู่แล้ว (เช่น GAS ยิงซ้ำ) → ตอบ `matched: true, already_paid: true`
     ทันที ไม่ออกใบเสร็จซ้ำ ไม่แก้ `crm_tax_tasks` ซ้ำ
  4. เทียบ `ocr_amount` กับ `expected_payment` ของแถวนั้น — ยอมคลาดเคลื่อนได้ **±20 บาท**
     (ค่านี้มาจาก usage notes เดิมใน `supabase-crm-billing-migration.sql` ห้ามเปลี่ยนโดยไม่ปรึกษาก่อน)
     - **ไม่ตรง** → ไม่แก้ไขฐานข้อมูลใดๆ ทั้งสิ้น ตอบ `{ matched: false, expected, received, diff }`
       กลับไปให้ GAS ไปแจ้งเตือนห้อง admin เอง
     - **ตรง** → `UPDATE crm_invoices SET status='paid', payment_received_at=now(),
       payment_amount=ocr_amount` แล้วพยายามออกใบเสร็จ FlowAccount + ส่งอีเมลลูกค้าแบบ
       best-effort (พลาดได้ ไม่ย้อนสถานะ paid กลับ — ไปออกซ้ำทีหลังผ่าน `flowaccount-sync`
       action `create_receipt_and_email` ได้) แล้ว upsert `crm_tax_tasks` ตั้ง
       `acct_fee='done', invoice_id=<id>` ด้วย `onConflict: 'client_id,year,month'`
       (รูปแบบเดียวกับที่ `confirmMarkPaid()` ในหน้า CRM ทำตอนบันทึกรับเงินด้วยมืออยู่แล้ว)
       ตอบ `{ matched: true, invoice_id, expected, received, receipt: {...}, tax_task_updated }`

## ENV ที่ต้องตั้งค่า (ยังไม่ได้ตั้ง — ฟังก์ชันจะ error แบบสุภาพจนกว่าจะตั้ง)

ตั้งผ่าน Supabase Dashboard → Edge Functions → `flowaccount-gas-webhook` → Secrets:

- `GAS_SHARED_SECRET` — สุ่มสตริงยาวๆ ขึ้นมาใหม่ (เช่นเดียวกับที่ `WEBHOOK_SECRET_KEY` เดิมสร้างด้วย
  `Utilities.getUuid()`) แล้วเก็บค่าเดียวกันไว้ฝั่ง GAS ผ่าน `PropertiesService` ด้วย — GAS ต้องส่งค่านี้
  มาใน body ทุกครั้งที่เรียก (`shared_secret`)
- `FLOWACCOUNT_CLIENT_ID` / `FLOWACCOUNT_CLIENT_SECRET` — ใช้ค่าเดียวกับที่ตั้งให้ `flowaccount-sync`

## สิ่งที่ยังไม่ยืนยัน

เหมือนกับ `flowaccount-sync` ทุกประการ (ดู README ของฟังก์ชันนั้น หัวข้อ "สิ่งที่ยังไม่ยืนยัน")
เพราะโค้ดเรียก FlowAccount ในไฟล์นี้ทำสิ่งเดียวกัน (ออกใบเสร็จ + ส่งอีเมล) เขียนแยกไว้ในไฟล์นี้เอง
โดยตั้งใจ ไม่ import ข้ามจากฟังก์ชันแรก เพราะสอง endpoint นี้เป็นคนละ trust boundary กัน
(JWT พนักงานจริง vs. shared secret ของ GAS) อยากให้ deploy/แก้ไขแยกจากกันได้อิสระ

## งานที่เหลือฝั่ง GAS (ยังไม่ได้ทำในเซสชันนี้ — คนละงาน)

ไฟล์นี้เป็นแค่ฝั่ง Supabase เท่านั้น ฝั่ง Apps Script (`Pending.gs`/`Archive.gs` หรือไฟล์ใหม่) ยังต้อง
เพิ่มโค้ดเรียก endpoint นี้เองหลัง OCR สลิปด้วย Gemini Vision เสร็จ (ยิง POST พร้อม
`shared_secret`/`client_id`/`year`/`month`/`ocr_amount` แล้วอ่านผล `matched` เพื่อตัดสินใจว่าจะ
แจ้งห้อง admin หรือไม่) — ยังไม่ได้ทำในงานนี้

## Deploy

Deploy แล้วผ่าน Supabase MCP ไปยัง project "Web" (`dqegkyobclqqichhnxfm`) — ถ้าจะ deploy ทับเอง
ผ่าน Dashboard: Edge Functions → Create a function → ตั้งชื่อ `flowaccount-gas-webhook` →
**ปิด Verify JWT** (สำคัญ — ต่างจาก `flowaccount-sync`) → วางโค้ดจาก `index.ts` → Deploy
