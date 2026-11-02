-- ============================================================
-- /customer — ติดตามเอกสารปิดงบการเงินรายลูกค้ารายปี
-- ============================================================
-- หน้า dcacc.dcbc.co.th/customer (repo dc-acc: customer/index.html) ใช้ตารางนี้
--   1) crm_clients.billing_type รับค่าใหม่ 'walkin' = ลูกค้าขาจร (จ้างปิดงบครั้งคราว
--      ไม่ใช่ลูกค้ารายเดือน/รายปี) — CRM ต้องกันค่านี้ออกจากหน้ารายเดือน/การเก็บเงิน
--      แบบเดียวกับ 'annual'
--   2) crm_fs_jobs = งานปิดงบ 1 แถวต่อลูกค้าต่อรอบปี (year_be เป็น พ.ศ. ตรงกับ URL
--      /customer/2569/EPED) ช่อง checks เก็บสถานะรายการเช็คลิสต์เป็น jsonb
--      { "<item_key>": { "s": "done"|"na", "by": "<uuid>", "at": "<timestamptz>" } }
--      รายการไหนไม่มี key = ยังรอ
--   3) crm_fs_set_check() ติ๊กทีละรายการแบบ atomic — สองคนติ๊กคนละรายการพร้อมกัน
--      จะไม่ทับกัน (ถ้าเขียน checks ทั้งก้อนจากหน้าเว็บจะทับกันเงียบๆ)
--
-- สิทธิ์: พนักงานทุกระดับ (org_get_role() ไม่ว่าง) อ่าน/เพิ่ม/แก้งานของลูกค้าที่ตัวเอง
-- "มองเห็น" ใน crm_clients ได้ (subquery ผ่าน RLS ของ crm_clients เอง จึงตามกฎทีม
-- ที่มีอยู่แล้ว ไม่ต้องเขียนซ้ำ) · ลบงานได้เฉพาะ owner/manager
-- รันซ้ำได้ (IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS)
-- ============================================================

ALTER TABLE public.crm_clients
  DROP CONSTRAINT IF EXISTS crm_clients_billing_type_check;
ALTER TABLE public.crm_clients
  ADD CONSTRAINT crm_clients_billing_type_check
  CHECK (billing_type = ANY (ARRAY['monthly','annual','filing','dissolved','walkin']));

CREATE TABLE IF NOT EXISTS public.crm_fs_jobs (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id   bigint      NOT NULL REFERENCES public.crm_clients(id) ON DELETE CASCADE,
  year_be     int         NOT NULL CHECK (year_be BETWEEN 2500 AND 2700),
  status      text        NOT NULL DEFAULT 'Pending'
              CHECK (status IN ('Pending','Preparing','Draft','Sent to Auditor','Paid','Uploaded')),
  note        text        NOT NULL DEFAULT '',
  checks      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid        DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, year_be)
);

CREATE INDEX IF NOT EXISTS crm_fs_jobs_year_idx ON public.crm_fs_jobs (year_be);

ALTER TABLE public.crm_fs_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS crm_fs_jobs_sel ON public.crm_fs_jobs;
CREATE POLICY crm_fs_jobs_sel ON public.crm_fs_jobs FOR SELECT
  USING (
    public.org_get_role() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.crm_clients c WHERE c.id = crm_fs_jobs.client_id)
  );

DROP POLICY IF EXISTS crm_fs_jobs_ins ON public.crm_fs_jobs;
CREATE POLICY crm_fs_jobs_ins ON public.crm_fs_jobs FOR INSERT
  WITH CHECK (
    public.org_get_role() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.crm_clients c WHERE c.id = crm_fs_jobs.client_id)
  );

DROP POLICY IF EXISTS crm_fs_jobs_upd ON public.crm_fs_jobs;
CREATE POLICY crm_fs_jobs_upd ON public.crm_fs_jobs FOR UPDATE
  USING (
    public.org_get_role() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.crm_clients c WHERE c.id = crm_fs_jobs.client_id)
  );

DROP POLICY IF EXISTS crm_fs_jobs_del ON public.crm_fs_jobs;
CREATE POLICY crm_fs_jobs_del ON public.crm_fs_jobs FOR DELETE
  USING (public.org_get_role() IN ('owner','manager'));

DROP TRIGGER IF EXISTS crm_fs_jobs_upd_at ON public.crm_fs_jobs;
CREATE TRIGGER crm_fs_jobs_upd_at
  BEFORE UPDATE ON public.crm_fs_jobs
  FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();

-- ติ๊ก/ยกเลิก 1 รายการ: p_state = 'done' | 'na' | NULL (NULL = กลับเป็น "รอ")
-- SECURITY INVOKER — UPDATE ผ่าน RLS ของผู้เรียกเหมือนแก้ตรงๆ
CREATE OR REPLACE FUNCTION public.crm_fs_set_check(p_job_id bigint, p_key text, p_state text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_checks jsonb;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'invalid item key';
  END IF;
  IF p_state IS NOT NULL AND p_state NOT IN ('done','na') THEN
    RAISE EXCEPTION 'invalid state';
  END IF;

  UPDATE public.crm_fs_jobs
     SET checks = CASE
           WHEN p_state IS NULL THEN checks - p_key
           ELSE jsonb_set(checks, ARRAY[p_key],
                  jsonb_build_object('s', p_state, 'by', auth.uid(), 'at', now()))
         END
   WHERE id = p_job_id
  RETURNING checks INTO v_checks;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found or not allowed';
  END IF;
  RETURN v_checks;
END;
$$;

REVOKE ALL ON FUNCTION public.crm_fs_set_check(bigint, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.crm_fs_set_check(bigint, text, text) TO authenticated;
