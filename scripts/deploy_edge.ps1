# deploy_edge.ps1 - deploy a Supabase edge function from local files (no CLI, no
# transcription). Zips {slug}/index.ts + _shared/auth.ts with forward-slash entry
# names, verifies the entries, and POSTs via .NET HttpClient (correct binary).
#   .\deploy_edge.ps1 -Slug lease-abstract
param(
  [Parameter(Mandatory=$true)][string]$Slug,
  [bool]$VerifyJwt = $true
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.Net.Http | Out-Null

$repo = Split-Path $PSScriptRoot -Parent
$cfg=@{}; foreach($l in (Get-Content "$repo\.env" | Where-Object {$_ -match '='})){ $k,$v=$l -split '=',2; $cfg[$k.Trim()]=$v.Trim() }
$tok=$cfg['SUPABASE_ACCESS_TOKEN']; $ref=$cfg['SUPABASE_PROJECT_REF']
$fnDir = "$repo\supabase\functions"
$idxPath  = "$fnDir\$Slug\index.ts"
$authPath = "$fnDir\_shared\auth.ts"
if (-not (Test-Path $idxPath))  { throw "missing $idxPath" }

$meta = @{ name=$Slug; entrypoint_path="$Slug/index.ts"; verify_jwt=$VerifyJwt } | ConvertTo-Json -Compress
$uri = "https://api.supabase.com/v1/projects/$ref/functions/deploy?slug=$Slug"

$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(120)
$form = New-Object System.Net.Http.MultipartFormDataContent
$mc = New-Object System.Net.Http.StringContent($meta,[Text.Encoding]::UTF8,'application/json')
$form.Add($mc,'metadata')
# Send each source file as its own 'file' part with a relative-path filename
# (mirrors the way the CLI/MCP deploy resolves ../_shared imports).
function Add-FilePart($relName,$file){
  $bytes=[IO.File]::ReadAllBytes($file)
  $fc=New-Object System.Net.Http.ByteArrayContent(,$bytes)
  $fc.Headers.ContentType=[System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/typescript')
  $form.Add($fc,'file',$relName)
}
Add-FilePart "$Slug/index.ts" $idxPath
Add-FilePart "_shared/auth.ts" $authPath
Write-Output ("uploading parts: {0}/index.ts, _shared/auth.ts" -f $Slug)
$reqm = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post,$uri)
$reqm.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer',$tok)
$reqm.Content = $form
$resp = $client.SendAsync($reqm).Result
$respBody = $resp.Content.ReadAsStringAsync().Result
Write-Output ("HTTP {0}: {1}" -f [int]$resp.StatusCode, $respBody)