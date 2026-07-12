# list_media_host_files.ps1  (ASCII only - PS 5.1)
# Authoritative list of files for the media host (OneDrive/SharePoint), derived
# by RE-PARSING the wiki content exactly like gen_help_library.ps1 (so filenames
# and paths are real), then cross-referencing the upload manifest.
#
# Media host  = every recording/audio  +  any document > 200MB (can't/shouldn't
#               live in Supabase; needs streaming/large-file hosting).
# Retry-to-Supabase = small docs that failed transiently (handled by re-running
#               gen_help_library.ps1, NOT by uploading to OneDrive).

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$wikiRoot = 'C:\Users\pskontos\Desktop\Software\wiki-portal\wiki-content'
$KM       = 'K:\Property Management'
$doneFile = Join-Path $env:TEMP 'help_lib_uploaded.txt'
$BIG_MB   = 200

$CATEGORY = @{
  'policy'='Policy Manual'; 'university'='M&J University'; 'forms'='Forms & Templates';
  'emergency'='Emergency & Life Safety';
  'accounting'='Departments'; 'leasing'='Departments'; 'marketing'='Departments';
  'operations'='Departments'; 'licensing'='Departments'; 'portfolio'='Departments';
  'esg'='Departments'; 'hr'='Departments'; 'events'='Departments'
}
$BASE_PREFIX = @{ 'university' = 'M & J University/'; 'emergency' = 'Emergency Procedures Manual/' }
$VIDEO = '.mp4','.mov','.wmv','.avi','.m4v'; $AUDIO = '.m4a','.mp3'
$DOC   = '.pdf','.docx','.doc','.xlsx','.xls','.xlsm','.pptx','.ppt','.csv'
function Md5Hash([string]$s){$m=[Security.Cryptography.MD5]::Create();$b=$m.ComputeHash([Text.Encoding]::UTF8.GetBytes($s));(($b|%{$_.ToString('x2')}) -join '').Substring(0,10)}

$done = @{}; if (Test-Path $doneFile){ Get-Content $doneFile | %{ if($_){ $done[$_]=$true } } }

$media = New-Object System.Collections.ArrayList   # recordings + big docs -> OneDrive
$retry = New-Object System.Collections.ArrayList   # small failed docs -> Supabase re-run

Get-ChildItem -LiteralPath $wikiRoot -Recurse -Filter *.md | ForEach-Object {
  $top = ($_.FullName.Substring($wikiRoot.Length).TrimStart('\') -split '\\')[0]
  if (-not $CATEGORY.ContainsKey($top)) { return }
  $sect = ''
  foreach ($l in [IO.File]::ReadAllLines($_.FullName,[Text.Encoding]::UTF8)) {
    if ($l -match '^title:\s*(.+)$') { $sect = $matches[1].Trim() }
    foreach ($m in [regex]::Matches($l, '\[([^\]]+)\]\(MEDIA_BASE/(.*?)\)(?=\s*(?:\||·|\[|$))')) {
      $rel = [uri]::UnescapeDataString($m.Groups[2].Value)
      if ($BASE_PREFIX.ContainsKey($top)) { $rel = $BASE_PREFIX[$top] + $rel }
      $ext = [IO.Path]::GetExtension($rel).ToLower()
      $kind = if ($VIDEO -contains $ext -or $AUDIO -contains $ext) {'media'} elseif ($DOC -contains $ext) {'doc'} else {'folder'}
      if ($kind -eq 'folder') { continue }
      $kpath = ($KM + '\' + ($rel -replace '/','\'))
      $mb = ''
      if (Test-Path -LiteralPath $kpath) { $mb = [math]::Round((Get-Item -LiteralPath $kpath).Length/1MB,1) }
      $fname = Split-Path $kpath -Leaf
      $key = 'forms/help/lib/' + (Md5Hash $rel) + $ext
      $rowObj = [pscustomobject]@{ Category=$CATEGORY[$top]; Section=$sect; File=$fname; SizeMB=$mb; KPath=$kpath }
      if ($kind -eq 'media') {
        [void]$media.Add($rowObj)                                   # all recordings -> host
      } elseif (-not $done.ContainsKey($key)) {                     # doc not uploaded
        if ($mb -ne '' -and [double]$mb -ge $BIG_MB) { [void]$media.Add($rowObj) }  # huge doc -> host
        else { [void]$retry.Add($rowObj) }                          # small -> retry to Supabase
      }
    }
  }
}

$media = @($media | Sort-Object -Property @{E={[double]($_.SizeMB)}} -Descending)
$retry = @($retry | Sort-Object File)
$totMB = ($media | Measure-Object SizeMB -Sum).Sum

$desk = [Environment]::GetFolderPath('Desktop')
$media | Select-Object Category,Section,File,SizeMB,KPath | Export-Csv -NoTypeInformation -Encoding UTF8 (Join-Path $desk 'onedrive-upload-list.csv')

$L = New-Object System.Collections.ArrayList
[void]$L.Add("ONEDRIVE / SHAREPOINT UPLOAD LIST")
[void]$L.Add(("{0} files, ~{1} GB total. Drag these into the shared media folder." -f $media.Count, [math]::Round($totMB/1024,1)))
[void]$L.Add("These are the recordings + a few very large decks that cannot live in the app's document store.")
[void]$L.Add("")
foreach ($r in $media) { [void]$L.Add(("  [{0,7} MB]  {1}" -f $r.SizeMB, $r.KPath)) }
[void]$L.Add("")
[void]$L.Add(("NOTE: {0} small files failed to upload transiently and will be re-sent to the app store (NOT OneDrive) - no action needed from you." -f $retry.Count))
$L -join "`r`n" | Out-File -Encoding UTF8 (Join-Path $desk 'onedrive-upload-list.txt')

Write-Host ("MEDIA HOST (OneDrive): {0} files, ~{1} GB" -f $media.Count, [math]::Round($totMB/1024,1))
Write-Host ("Transient small-doc failures to retry in Supabase: {0}" -f $retry.Count)
Write-Host ("Wrote: {0}\onedrive-upload-list.csv (+ .txt)" -f $desk)
Write-Host ""
$media | Select-Object SizeMB, Category, File | Format-Table -AutoSize | Out-String -Width 160 | Write-Host
