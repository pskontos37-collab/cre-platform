$ErrorActionPreference = "Continue"
$SP = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad"
$log = "$SP\batch_is.log"
"start $(Get-Date -Format HH:mm:ss)" | Out-File $log

# property_id -> K: working folder (single-IS properties; Penn Center & Southlands office/retail handled separately)
$map = @(
  @{ id='7fc45bb1-1917-4619-9415-8ca666e4653f'; folder='Chapel Hills';          label='Chapel Hills East' }
  @{ id='4dd56eb8-d2f6-48f5-a09e-00585c329b5d'; folder='4500 Cherry Creek';     label='Cherry Creek' }
  @{ id='3c66605b-f947-45a8-aa27-4d95ae3c554d'; folder='East Gate';             label='East Gate Square' }
  @{ id='d5a4ed03-0b60-4168-9208-83822dd24884'; folder='Gateway Port Chester';  label='Gateway Port Chester' }
  @{ id='d4f08824-2d88-472d-b7aa-a703310c2aaf'; folder='Magnolia';              label='Magnolia Park' }
  @{ id='e7d9a97e-668c-4a50-a966-92ce919f1f95'; folder='Meridian';              label='Meridian Plaza' }
  @{ id='87c85b3a-2704-4114-b7b0-ce65a2e971e0'; folder='One East Erie';         label='One East Erie' }
  @{ id='a5407d2f-b12d-4922-9cc0-41dde8044ec9'; folder='Outlets of Maui';       label='Outlets of Maui' }
  @{ id='8c73d962-5271-4202-bb05-0ec7dc9b358d'; folder='Parker Ranch';          label='Parker Ranch Center' }
  @{ id='cb1fd6c0-159f-42ed-b677-85b776c0d98b'; folder='Waterfront';            label='The Waterfront' }
  @{ id='63036a6e-406a-4016-a8f8-cf9d73e073ea'; folder='Mililani';              label='Town Center of Mililani' }
  @{ id='b4de870b-ef45-4d97-803b-03fdfa81e15e'; folder='Bank Financial';        label='Bank Financial Building' }
)

foreach ($p in $map) {
  $root = "K:\Working Files - $($p.folder)"
  if (-not (Test-Path $root)) { "$(Get-Date -Format HH:mm:ss)  SKIP $($p.label): folder not found" | Out-File $log -Append; continue }
  $is = Get-ChildItem -LiteralPath $root -Recurse -File -EA SilentlyContinue |
        Where-Object { $_.Extension -eq '.pdf' -and $_.Name -match 'Income Statement' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $is) { "$(Get-Date -Format HH:mm:ss)  SKIP $($p.label): no Income Statement PDF found" | Out-File $log -Append; continue }

  # derive period: prefer M.D.YY or M.YY in filename, else parent month-folder, else LastWriteTime
  $y=$null; $m=$null
  if ($is.Name -match '(\d{1,2})\.\d{1,2}\.(\d{2})\b') { $m=[int]$matches[1]; $y=2000+[int]$matches[2] }
  elseif ($is.Name -match '(\d{1,2})\.(\d{2})\b')       { $m=[int]$matches[1]; $y=2000+[int]$matches[2] }
  elseif ($is.Directory.Name -match '(\d{1,2})[.\-](\d{2,4})') { $m=[int]$matches[1]; $yy=$matches[2]; $y=[int]$(if($yy.Length -eq 2){"20$yy"}else{$yy}) }
  else { $m=$is.LastWriteTime.Month; $y=$is.LastWriteTime.Year }
  if ($m -lt 1 -or $m -gt 12) { $m=$is.LastWriteTime.Month; $y=$is.LastWriteTime.Year }

  "$(Get-Date -Format HH:mm:ss)  LOAD $($p.label): $($is.Name)  -> $y-$m" | Out-File $log -Append
  try {
    $out = & "$SP\load_is.ps1" -Path $is.FullName -PropertyId $p.id -Year $y -Month $m 2>&1 | Out-String
    "$(Get-Date -Format HH:mm:ss)  OK   $($p.label): $($out -replace "`r?`n",' | ')" | Out-File $log -Append
  } catch {
    "$(Get-Date -Format HH:mm:ss)  ERR  $($p.label): $($_.Exception.Message)" | Out-File $log -Append
  }
}
"done $(Get-Date -Format HH:mm:ss)" | Out-File $log -Append