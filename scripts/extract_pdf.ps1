param([Parameter(Mandatory=$true)][string]$Path, [Parameter(Mandatory=$true)][string]$Prompt, [int]$MaxTokens=4096, [string]$Model="claude-opus-4-8")
$ErrorActionPreference = "Stop"
$key = (Get-Content "C:\Users\pskontos\AppData\Local\Temp\claude\C--Users-pskontos-Desktop-Software\c9d09617-ceab-4ad8-9e65-cb51a8403010\scratchpad\secret.json" | ConvertFrom-Json)[0].value
$b64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($Path))
$body = @{
  model = $Model; max_tokens = $MaxTokens
  messages = @(@{ role="user"; content=@(
    @{ type="document"; source=@{ type="base64"; media_type="application/pdf"; data=$b64 } },
    @{ type="text"; text=$Prompt }
  )})
} | ConvertTo-Json -Depth 12
$bb = [System.Text.Encoding]::UTF8.GetBytes($body)
try {
  $r = Invoke-RestMethod -Method Post -Uri "https://api.anthropic.com/v1/messages" `
    -Headers @{ "x-api-key"=$key; "anthropic-version"="2023-06-01" } -ContentType "application/json" -Body $bb -TimeoutSec 300
  ($r.content | Where-Object { $_.type -eq "text" } | Select-Object -First 1).text
} catch {
  Write-Output "ERR"
  if ($_.ErrorDetails.Message) { Write-Output $_.ErrorDetails.Message }
  elseif ($_.Exception.Response) { $sr=New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); Write-Output $sr.ReadToEnd() }
  else { Write-Output $_.Exception.Message }
}