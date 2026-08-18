-- ============================================================
-- Shared "org" (organization-wide) staff/auth module
--
-- แยกระบบพนักงาน (เดิมผูกกับ CRM ในชื่อ crm_staff และตารางบริวาร)
-- ออกมาเป็นส่วนกลาง org_* เพื่อให้ CRM, Calendar, และ AI chat
-- อ้างอิงพนักงาน/ทีม/สิทธิ์ชุดเดียวกัน — ล็อกอินครั้งเดียว (ผ่าน
-- Supabase auth.users ที่ทุกแอพแชร์อยู่แล้ว) เห็นสิทธิ์/ทีมตรงกันหมด
--
-- ทำไมปลอดภัย: ALTER TABLE/FUNCTION ... RENAME ใน Postgres จะรักษา
-- foreign key, RLS policy, index ของเดิมไว้ทั้งหมดโดยอัตโนมัติ
-- (Postgres อ้างอิงกันด้วย OID ภายใน ไม่ใช่ชื่อ text) — RLS policy
-- อีกหลายสิบอันของ CRM เดิม (บน crm_clients, crm_tax_tasks,
-- crm_staff_clients, crm_client_credentials ฯลฯ ที่เรียก
-- crm_get_role()) จะยังทำงานถูกต้องทันทีโดยไม่ต้องแก้อะไรเพิ่ม
--
-- สิ่งที่ "ต้อง" แก้เพิ่มหลัง apply ไฟล์นี้ (ฝั่งโค้ด ไม่ใช่ SQL):
--   - crm/index.html:  .from('crm_staff')          -> .from('org_staff')
--                       .from('crm_teams')          -> .from('org_teams')
--                       .from('crm_team_members')   -> .from('org_team_members')
--                       .from('crm_staff_requests') -> .from('org_staff_requests')
--                       .rpc('crm_get_role')            -> .rpc('org_get_role')
--                       .rpc('crm_complete_first_login') -> .rpc('org_complete_first_login')
--   - supabase/functions/admin-staff/index.ts: table names เดียวกันข้างบน
--   - dcbc-calendar.html (Calendar): เพิ่มการเช็คสิทธิ์ผ่าน org_staff/org_get_role() แบบเดียวกับ CRM
--
-- ⚠️ ยังไม่ apply กับฐานข้อมูลจริง (Supabase project "Web",
-- ref dqegkyobclqqichhnxfm) — ฐานข้อมูลจริงมี crm_staff ที่มีข้อมูล
-- พนักงานจริงอยู่แล้ว (role 5 ระดับ, staff_code, birthdate) แต่ยังไม่มี
-- nickname/teams/staff_requests/staff_private ตาม migration พวกนี้
-- ที่ยังไม่เคย apply จริง — รอ user คอนเฟิร์มที่อยู่เว็บใหม่ก่อน
-- ดู CLAUDE.md หัวข้อ "แผนแยกระบบพนักงานเป็นส่วนกลาง"
--
-- SAFE TO RE-RUN (idempotent: ข้ามอันที่ rename ไปแล้ว)
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='crm_staff')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='org_staff') THEN
    ALTER TABLE public.crm_staff RENAME TO org_staff;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='crm_staff_private')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='org_staff_private') THEN
    ALTER TABLE public.crm_staff_private RENAME TO org_staff_private;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='crm_staff_requests')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='org_staff_requests') THEN
    ALTER TABLE public.crm_staff_requests RENAME TO org_staff_requests;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='crm_teams')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='org_teams') THEN
    ALTER TABLE public.crm_teams RENAME TO org_teams;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='crm_team_members')
     AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='org_team_members') THEN
    ALTER TABLE public.crm_team_members RENAME TO org_team_members;
  END IF;
END $$;

-- crm_get_role() -> org_get_role(): RLS policy อื่นๆ ของ CRM ที่เรียก
-- crm_get_role() อยู่แล้ว (ทั้งหมด) จะยังทำงานถูกต้องหลัง rename นี้
-- โดยอัตโนมัติ เพราะ Postgres ผูก function call ใน policy ด้วย OID
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='crm_get_role')
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='org_get_role') THEN
    ALTER FUNCTION public.crm_get_role() RENAME TO org_get_role;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='crm_complete_first_login')
     AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='org_complete_first_login') THEN
    ALTER FUNCTION public.crm_complete_first_login(text) RENAME TO org_complete_first_login;
  END IF;
END $$;

COMMENT ON TABLE public.org_staff IS 'พนักงานทั้งหมดขององค์กร (ส่วนกลาง) — CRM, Calendar, AI chat ใช้ตารางเดียวกันนี้สำหรับสิทธิ์/ทีม/โปรไฟล์ (เดิมชื่อ crm_staff)';
