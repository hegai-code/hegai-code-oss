@echo off
chcp 65001 >nul
title HegAI Gateway - Codex / ChatGPT
powershell -NoProfile -ExecutionPolicy Bypass -Command "$src=Get-Content -LiteralPath '%~f0' -Encoding UTF8; $code=($src | Where-Object { $_ -like '#PS#*' } | ForEach-Object { $_.Substring(4) }) -join [Environment]::NewLine; Invoke-Expression $code"
echo.
pause
exit /b
#PS#$ErrorActionPreference = 'Stop'
#PS#try {
#PS#  $key   = '__KEY__'
#PS#  $base  = '__BASE__'
#PS#  $model = '__MODEL__'
#PS#  $effort = '__EFFORT__'
#PS#  $dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
#PS#  $cfg = Join-Path $dir 'config.toml'
#PS#  New-Item -ItemType Directory -Force -Path $dir | Out-Null
#PS#  $orig = @()
#PS#  if (Test-Path -LiteralPath $cfg) {
#PS#    Copy-Item -LiteralPath $cfg -Destination ($cfg + '.bak-' + (Get-Date).ToString('yyyyMMdd-HHmmss')) -Force
#PS#    $orig = @(Get-Content -LiteralPath $cfg -Encoding UTF8)
#PS#  }
#PS#  $keep = New-Object System.Collections.Generic.List[string]
#PS#  $skipblock = $false; $skiptable = $false; $seentable = $false
#PS#  foreach ($line in $orig) {
#PS#    if ($line -match '^\s*#\s*>>>\s*hegai-gateway') { $skipblock = $true; continue }
#PS#    if ($line -match '^\s*#\s*<<<\s*hegai-gateway') { $skipblock = $false; continue }
#PS#    if ($skipblock) { continue }
#PS#    if ($line -match '^\s*\[model_providers\.hegai\]\s*$') { $skiptable = $true; continue }
#PS#    if ($skiptable) { if ($line -match '^\s*\[') { $skiptable = $false } else { continue } }
#PS#    if ($line -match '^\s*\[') { $seentable = $true }
#PS#    if (-not $seentable -and $line -match '^\s*model\s*=') { continue }
#PS#    if (-not $seentable -and $line -match '^\s*model_provider\s*=') { continue }
#PS#    if (-not $seentable -and $line -match '^\s*model_reasoning_effort\s*=') { continue }
#PS#    $keep.Add($line)
#PS#  }
#PS#  $res = New-Object System.Collections.Generic.List[string]
#PS#  $res.Add('model = "' + $model + '"')
#PS#  $res.Add('model_provider = "hegai"')
#PS#  $res.Add('model_reasoning_effort = "' + $effort + '"')
#PS#  foreach ($l in $keep) { $res.Add($l) }
#PS#  $res.Add('')
#PS#  $res.Add('# >>> hegai-gateway (managed by installer - do not edit inside) >>>')
#PS#  $res.Add('[model_providers.hegai]')
#PS#  $res.Add('name = "HegAI Gateway"')
#PS#  $res.Add('base_url = "' + $base + '"')
#PS#  $res.Add('experimental_bearer_token = "' + $key + '"')
#PS#  $res.Add('wire_api = "responses"')
#PS#  $res.Add('# <<< hegai-gateway <<<')
#PS#  $enc = New-Object System.Text.UTF8Encoding($false)
#PS#  [System.IO.File]::WriteAllLines($cfg, $res, $enc)
#PS#  Write-Host ''
#PS#  Write-Host '  HegAI-шлюз подключён.'
#PS#  Write-Host ('  Файл: ' + $cfg)
#PS#  Write-Host ('  Провайдер: hegai, модель: ' + $model)
#PS#  Write-Host ''
#PS#  Write-Host '  Откройте приложение ChatGPT или запустите:  codex'
#PS#  Write-Host '  Вернуть обычный ChatGPT: удалите строку model_provider = hegai из файла (бэкап рядом).'
#PS#} catch {
#PS#  Write-Host ('  Ошибка: ' + $_.Exception.Message)
#PS#}
