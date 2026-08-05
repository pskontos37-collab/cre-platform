-- 20240197_target_allowance_gl_note
-- Closes the "was the Target §6.3(C) allowance actually paid?" question (raised in the
-- 20240175 adjudication) with the GL answer, recorded where the question lives.
do $$
declare v_target uuid; n int;
begin
  select la.id into strict v_target from lease_abstracts la join properties p on p.id = la.property_id
    where p.name ilike '%gateway%' and la.tenant_name ilike 'target%';
  if v_target::text not like '0ba3e9b1%' then
    raise exception 'Target abstract id drifted: %', v_target;
  end if;
  update lease_abstracts set
    review_note = coalesce(review_note || chr(10), '') ||
      '2026-08-05 GL check (mig 20240197): the §6.3(C) Allowance WAS PAID — AP entry 2021-08-25 "TAGET CORPORATION 2217 8/25/2021 TI" $2,617,439.74, capitalized 2022-03-09 "place Target TI Allow in service" at the same figure. That is $224,895.26 BELOW the lease-stated $2,842,335.00; no second Target Corporation payment exists in the loaded 2019-2026 Gateway GL. Whether the delta was offset against tenant charges or remains owing needs the disbursement backup. The §6.3(C) contingent increase (max +$299,580) was evidently never trued up — the paid amount sits below even the base figure.'
  where id = v_target;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Target update touched % rows', n; end if;
end $$;
