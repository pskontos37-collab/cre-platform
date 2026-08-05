
create or replace view public.v_scan_report with (security_invoker = true) as
with win as (select (now() - interval '24 hours') as since),
nf as (
  select coalesce(p.name, '(company-wide)') as property,
         coalesce(nullif(d.title, ''), d.file_name, d.id::text) as title,
         d.created_at,
         substring(d.file_path from '\\TENANTS\\([^\\]+)') as tenant_folder
  from documents d
  left join properties p on p.id = d.property_id
  cross join win
  where d.created_at > win.since and d.storage_path like 'p/%'
),
nf_by_prop as (
  select coalesce(string_agg('<li>' || property || ': ' || cnt || ' file(s)</li>', ''), '') as items
  from (select property, count(*) cnt from nf group by property) s
),
nf_list as (
  select coalesce(string_agg('<li>' || property || ' — ' || title ||
           coalesce(' <i>(' || tenant_folder || ')</i>', '') || '</li>', ''), '') as items
  from (select * from nf order by created_at desc limit 60) x
),
rl as (
  select tenant_name, doc_title, action, material,
    case when jsonb_typeof(changes) = 'object'
         then (select string_agg(k, ', ') from jsonb_object_keys(changes) k) else '' end as fields
  from abstract_refresh_log cross join win where created_at > win.since
),
agg as (
  select
    (select count(*) from nf) as new_files,
    count(*) filter (where action <> 'locked_needs_review') as refreshed_n,
    count(*) filter (where action = 'locked_needs_review') as flagged_n,
    coalesce(string_agg('<li><b>' || tenant_name || '</b>' || coalesce(' — ' || nullif(fields,''), '') ||
      case when material then ' <b>(material change)</b>' else '' end || '</li>', '')
      filter (where action <> 'locked_needs_review'), '') as refreshed_items,
    coalesce(string_agg('<li><b>' || tenant_name || '</b> — new doc "' || coalesce(doc_title,'') ||
      '" (locked; needs human review)</li>', '')
      filter (where action = 'locked_needs_review'), '') as flagged_items
  from rl
),
hy as (
  select count(*) as text_chunks_added, count(distinct document_id) as docs_text_indexed
  from document_chunks cross join win
  where kind = 'text' and created_at > win.since
)
select
  current_date as report_date,
  agg.new_files, agg.refreshed_n as abstracts_refreshed, agg.flagged_n as abstracts_flagged,
  ('<h2>CRE Nightly Scan — ' || to_char(now(), 'YYYY-MM-DD') || '</h2>'
   || '<p><b>New files (last 24h): ' || agg.new_files || '</b></p>'
   || case when agg.new_files > 0 then '<ul>' || nf_by_prop.items || '</ul>'
        || '<details><summary>File list</summary><ul>' || nf_list.items || '</ul></details>' else '' end
   || '<p><b>Abstracts auto-refreshed: ' || agg.refreshed_n || '</b></p>'
   || case when agg.refreshed_n > 0 then '<ul>' || agg.refreshed_items || '</ul>' else '' end
   || case when agg.flagged_n > 0 then '<p><b>Locked abstracts flagged (new docs): ' || agg.flagged_n
        || '</b></p><ul>' || agg.flagged_items || '</ul>' else '' end
   || case when hy.text_chunks_added > 0 then '<p><b>Corpus text/OCR layer (last 24h):</b> '
        || hy.text_chunks_added || ' text chunks added across ' || hy.docs_text_indexed || ' document(s)</p>' else '' end
  ) as body_html,
  hy.text_chunks_added, hy.docs_text_indexed
from agg cross join nf_by_prop cross join nf_list cross join hy;
