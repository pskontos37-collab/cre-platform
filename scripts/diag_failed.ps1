# diag_failed.ps1 - identify the persistently-failing library uploads.
# Rebuilds key->K:path exactly like gen_help_library.ps1, matches the FAILED
# KEYS from the last run's log, and reports real filename + size, then attempts
# one upload per file capturing the actual server error.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$wikiRoot = 'C:\Users\pskontos\Desktop\Software\wiki-portal\wiki-content'
$KM = 'K:\Property Management'
$log = Join-Path $env:TEMP 'help_upload6.log'
$envMap=@{}; Get-Content (Join-Path $repoRoot '.env') | %{ if($_ -match '^\s*([^#=]+)=(.*)$'){$envMap[$matches[1].Trim()]=$matches[2].Trim()} }
$baseUrl=$envMap['VITE_SUPABASE_URL']; $svc=$envMap['SUPABASE_SERVICE_JWT']

$BASE_PREFIX=@{'university'='M & J University/';'emergency'='Emergency Procedures Manual/'}
$CATS='policy','university','forms','emergency','accounting','leasing','marketing','operations','licensing','portfolio','esg','hr','events'
$DOC='.pdf','.docx','.doc','.xlsx','.xls','.xlsm','.pptx','.ppt','.csv'
function Md5([string]$s){$m=[Security.Cryptography.MD5]::Create();$b=$m.ComputeHash([Text.Encoding]::UTF8.GetBytes($s));(($b|%{$_.ToString('x2')})-join'').Substring(0,10)}

# failed keys from the log
$failed = Get-Content $log | Where-Object { $_ -match 'forms/help/lib/' } | ForEach-Object { $_.Trim() }
Write-Host ("Failed keys parsed: {0}" -f $failed.Count)

# build key -> path
$map=@{}
Get-ChildItem -LiteralPath $wikiRoot -Recurse -Filter *.md | ForEach-Object {
  $top=($_.FullName.Substring($wikiRoot.Length).TrimStart('\') -split '\\')[0]
  if($CATS -notcontains $top){return}
  foreach($l in [IO.File]::ReadAllLines($_.FullName,[Text.Encoding]::UTF8)){
    foreach($m in [regex]::Matches($l,'\[([^\]]+)\]\(MEDIA_BASE/(.*?)\)(?=\s*(?:\||·|\[|$))')){
      $rel=[uri]::UnescapeDataString($m.Groups[2].Value)
      if($BASE_PREFIX.ContainsKey($top)){$rel=$BASE_PREFIX[$top]+$rel}
      $ext=[IO.Path]::GetExtension($rel).ToLower()
      if($DOC -notcontains $ext){continue}
      $key='forms/help/lib/'+(Md5 $rel)+$ext
      if(-not $map.ContainsKey($key)){$map[$key]=($KM+'\'+($rel -replace '/','\'))}
    }
  }
}

function Get-Mime([string]$e){switch($e){'.pdf'{'application/pdf'}'.xls'{'application/vnd.ms-excel'}'.xlsx'{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}'.doc'{'application/msword'}'.docx'{'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}'.ppt'{'application/vnd.ms-powerpoint'}'.pptx'{'application/vnd.openxmlformats-officedocument.presentationml.presentation'}default{'application/octet-stream'}}}

Write-Host ""
foreach($k in $failed){
  $p=$map[$k]
  if(-not $p){ Write-Host ("? {0}  (no path match)" -f $k); continue }
  $name=Split-Path $p -Leaf
  if(-not (Test-Path -LiteralPath $p)){ Write-Host ("MISSING  {0}" -f $name); continue }
  $mb=[math]::Round((Get-Item -LiteralPath $p).Length/1MB,1)
  $err=''
  try {
    Invoke-RestMethod -Method Post -Uri "$baseUrl/storage/v1/object/documents/$k" -Headers @{Authorization="Bearer $svc";'x-upsert'='true'} -ContentType (Get-Mime ([IO.Path]::GetExtension($p))) -InFile $p -UserAgent 'diag' -TimeoutSec 300 | Out-Null
    $err='OK-NOW'
  } catch {
    $err=$_.Exception.Message
    if($_.Exception.Response){ try{ $sr=New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); $err=$sr.ReadToEnd() }catch{} }
  }
  Write-Host ("{0,7} MB  {1}`n           -> {2}" -f $mb, $name, $err)
}
