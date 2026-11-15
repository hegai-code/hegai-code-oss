# HegAI Gateway - установка Codex CLI и подключение к шлюзу (Windows / PowerShell).
# Запуск:  $env:HEGAI_API_KEY='sk-bf-...'; irm https://code.acme.test/install/codex-gateway.ps1 | iex
#
# КОДИРОВКА: не ставьте сюда длинное тире (U+2014) и стрелки (U+2192). Файл в
# UTF-8 без BOM, Windows PowerShell 5.1 читает такой .ps1 в системной ANSI, и
# байты именно этих двух символов складываются в кавычку, которая обрывает
# строку и валит парсинг всего файла. Кириллица, «» и … безопасны.
$ErrorActionPreference = 'Stop'
try {
  $base  = '__BASE__'
  $model = '__MODEL__'
  # Без этой строки Codex стартует с 'reasoning effort: none'.
  $effort = '__EFFORT__'
  # Key comes either as the first argument (universal cmd/PowerShell command,
  # invoked via [scriptblock]::Create) or as $env:HEGAI_API_KEY (plain irm | iex).
  $key = if ($args.Count -ge 1 -and -not [string]::IsNullOrWhiteSpace($args[0])) { $args[0] } else { $env:HEGAI_API_KEY }
  if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host '  Нет ключа. Открой code.acme.test/access и скопируй команду для Windows целиком.'
    return
  }

  # 1. Codex CLI.
  if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    Write-Host '  Codex CLI не найден - ставлю через npm...'
    if (Get-Command npm -ErrorAction SilentlyContinue) {
      npm install -g '@openai/codex'
    } else {
      Write-Host '  Нужен Node.js. Поставь с https://nodejs.org и повтори команду.'
      return
    }
  }

  # 2. Направить Codex через шлюз HegAI (мерж в ~/.codex/config.toml).
  $dir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
  $cfg = Join-Path $dir 'config.toml'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $orig = @()
  if (Test-Path -LiteralPath $cfg) {
    Copy-Item -LiteralPath $cfg -Destination ($cfg + '.bak-' + (Get-Date).ToString('yyyyMMdd-HHmmss')) -Force
    $orig = @(Get-Content -LiteralPath $cfg -Encoding UTF8)
  }
  $keep = New-Object System.Collections.Generic.List[string]
  $skipblock = $false; $skiptable = $false; $seentable = $false
  foreach ($line in $orig) {
    if ($line -match '^\s*#\s*>>>\s*hegai-gateway') { $skipblock = $true; continue }
    if ($line -match '^\s*#\s*<<<\s*hegai-gateway') { $skipblock = $false; continue }
    if ($skipblock) { continue }
    if ($line -match '^\s*\[model_providers\.hegai\]\s*$') { $skiptable = $true; continue }
    if ($skiptable) { if ($line -match '^\s*\[') { $skiptable = $false } else { continue } }
    if ($line -match '^\s*\[') { $seentable = $true }
    if (-not $seentable -and $line -match '^\s*model\s*=') { continue }
    if (-not $seentable -and $line -match '^\s*model_provider\s*=') { continue }
    if (-not $seentable -and $line -match '^\s*model_reasoning_effort\s*=') { continue }
    $keep.Add($line)
  }
  $res = New-Object System.Collections.Generic.List[string]
  $res.Add('model = "' + $model + '"')
  $res.Add('model_provider = "hegai"')
  $res.Add('model_reasoning_effort = "' + $effort + '"')
  foreach ($l in $keep) { $res.Add($l) }
  $res.Add('')
  $res.Add('# >>> hegai-gateway (managed by installer - do not edit inside) >>>')
  $res.Add('[model_providers.hegai]')
  $res.Add('name = "HegAI Gateway"')
  $res.Add('base_url = "' + $base + '"')
  $res.Add('experimental_bearer_token = "' + $key + '"')
  $res.Add('wire_api = "responses"')
  $res.Add('# <<< hegai-gateway <<<')
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($cfg, $res, $enc)

  Write-Host ''
  Write-Host '  Готово. Codex подключён к шлюзу HegAI.'
  Write-Host ('  Файл: ' + $cfg + '   модель: ' + $model)
  Write-Host '  Запусти:  codex'
  Write-Host '  Вернуть обычный ChatGPT: удали строку model_provider = hegai из файла (бэкап рядом).'
  Write-Host ''
} catch {
  Write-Host ('  Ошибка: ' + $_.Exception.Message)
}
