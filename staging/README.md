# Staging — เตรียมไว้ ยังไม่ live

โฟลเดอร์นี้เก็บโค้ดที่ปรับให้ใช้ระบบพนักงานกลาง (`org_staff` แทน `crm_staff` เดิม) แล้ว
แต่**ยังไม่ได้ apply migration จริงกับฐานข้อมูล และยังไม่ได้ทำให้เป็นหน้าเว็บที่เข้าถึงได้**
(ไม่ได้อยู่ที่ path `/crm` หรือ `/calendar` จริงๆ ของเว็บนี้ — อยู่ใน `staging/` กันสับสนกับของจริง)

## เนื้อหา
- `crm/index.html` — CRM เวอร์ชันใหม่ (จาก `crmcomplete.zip` ที่ผู้ใช้อัปโหลด) ปรับ table/function
  name เป็น `org_*` แล้ว (13 จุด — ดูรายละเอียดใน CLAUDE.md หัวข้อ sub-agent ที่ทำงานนี้)
- `crm/index.ts` — Edge Function `admin-staff` (คัดลอกมาเฉยๆ **ยังไม่ได้ปรับ** table name เป็น org_*
  — ต้องทำก่อนใช้งานจริง เพราะฟังก์ชันนี้น่าจะ query ตาราง `crm_staff` เดิมด้วย)
- `calendar/index.html` — ปฏิทินงาน ปรับจุดเดียว (`crm_staff` → `org_staff`) แล้ว

## ก่อนจะเอาขึ้นจริง ต้องทำอีก
1. Apply `supabase-org-staff-shared-migration.sql` (อยู่ที่ root ของ repo นี้) กับ Supabase project
   "Web" (ref `dqegkyobclqqichhnxfm`) จริง — **ยังไม่ทำ รอ user คอนเฟิร์ม**
2. ปรับ `crm/index.ts` (admin-staff Edge Function) ให้ใช้ table name `org_*` เหมือนกัน แล้ว deploy ทับของเดิม
3. ย้ายไฟล์จาก `staging/crm/` และ `staging/calendar/` ไปเป็น `/crm/index.html` และ `/calendar/index.html` จริงที่ root
4. ทดสอบ login + ทุกฟีเจอร์ก่อนประกาศว่าใช้งานได้จริง
