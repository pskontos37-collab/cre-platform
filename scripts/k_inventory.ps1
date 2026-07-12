$ErrorActionPreference = "SilentlyContinue"
$root = "K:\"
$out  = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad\k_inventory.csv"
$log  = "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad\k_inventory.log"
"start $(Get-Date -Format HH:mm:ss)" | Out-File $log
$rows = New-Object System.Collections.ArrayList

# Only the per-property "Working Files - *" folders (skip corporate/system dirs)
foreach ($p in (Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -like 'Working Files - *' } | Sort-Object Name)) {
  $pdf=0; $xls=0; $doc=0; $img=0; $eml=0; $oth=0; $count=0; [int64]$bytes=0
  Get-ChildItem -LiteralPath $p.FullName -Recurse -File | ForEach-Object {
    $count++; $bytes += $_.Length
    switch -Regex ($_.Extension.ToLower()) {
      '^\.pdf$'                 { $pdf++ }
      '^\.(xlsx|xls|xlsm|csv)$' { $xls++ }
      '^\.(docx|doc|rtf)$'      { $doc++ }
      '^\.(png|jpg|jpeg|tif|tiff|gif|bmp)$' { $img++ }
      '^\.(msg|eml)$'           { $eml++ }
      default                   { $oth++ }
    }
  }
  $null = $rows.Add([pscustomobject]@{
    Property=($p.Name -replace '^Working Files - ',''); Files=$count; SizeGB=[math]::Round($bytes/1GB,2)
    PDF=$pdf; Excel=$xls; Word=$doc; Image=$img; Email=$eml; Other=$oth
  })
  $rows | Export-Csv -LiteralPath $out -NoTypeInformation -Encoding UTF8
  "$(Get-Date -Format HH:mm:ss)  $($p.Name): $count files, $([math]::Round($bytes/1GB,2)) GB" | Out-File $log -Append
}
"done $(Get-Date -Format HH:mm:ss)" | Out-File $log -Append