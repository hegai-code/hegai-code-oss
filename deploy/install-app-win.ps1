# Hegai Code для Windows - установка одной командой:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://code.acme.test/install/app-win.ps1 | iex"
#
# Скачивает установщик HegaiCode-win-setup.exe (всегда от Hegai, см. CC_APP_DL) и запускает его. Ставится
# в профиль пользователя, БЕЗ прав администратора - та же логика, по которой
# install-win.ps1 заводит агента пользовательской задачей, а не службой SYSTEM:
# приложению нужен профиль конкретного человека.
#
# Той же командой приложение потом обновляется.
#
# Переменные для нестандартных случаев:
#   CC_APP_BASE - другой хаб (по умолчанию https://code.acme.test). Хаб
#                 запоминается в приложении (файл hub-url), и оно открывает его.
#   CC_APP_DL   - откуда качать установщик (по умолчанию — раздача Hegai:
#                 собственные хабы клиентов сборок не раздают)
#
# КОДИРОВКА. Файл в UTF-8 без BOM, и Windows PowerShell 5.1 читает такой .ps1 в
# системной ANSI (у нас cp1251). Кириллица это переживает - она превращается в
# кракозябры, но парсер не ломает. А вот ДВА символа ломают, потому что их
# UTF-8-байты в cp1251 читаются как кавычка и обрывают строку:
#     "-" U+2014 -> ...U+201D (закрывающая двойная)
#     "->" U+2192 -> ...U+2019 (закрывающая одинарная)
# Из-за второго скрипт не парсился вовсе (01.09.2026). Через `irm | iex` это не
# видно - там ответ декодируется как UTF-8 по charset, - но сохранённый файл,
# запущенный через -File, падал до первой команды.
# Не возвращайте сюда длинное тире и стрелки; «», … и кириллица безопасны.

$ErrorActionPreference = 'Stop'

$base = if ($env:CC_APP_BASE) { $env:CC_APP_BASE.TrimEnd('/') } else { 'https://code.acme.test' }
# Две строки с пометкой vendor-literal хаб при выдаче скрипта НЕ переписывает
# (server-rs/src/selfhost.rs): сборки лежат у Hegai, а не на хабе клиента.
$defaultHub = 'https://code.acme.test' # vendor-literal
$dl = if ($env:CC_APP_DL) { $env:CC_APP_DL.TrimEnd('/') } else { 'https://code.acme.test/dl' } # vendor-literal
$setupName = 'HegaiCode-win-setup.exe'

if ($env:OS -ne 'Windows_NT') {
  Write-Error 'Hegai Code для Windows ставится только на Windows.'
  exit 1
}

# WebView2 - движок окна. На Windows 11 и обновлённой Windows 10 он уже есть;
# установщик докачает его сам, если нет, поэтому здесь только предупреждение,
# а не остановка.
$wv = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if (-not (Test-Path $wv)) {
  Write-Host '==> WebView2 не найден - установщик докачает его (нужен интернет).'
}

$tmp = Join-Path $env:TEMP ("hegai-code-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$setup = Join-Path $tmp $setupName

try {
  Write-Host '==> Скачиваю Hegai Code…'
  # Progress bar off: on a slow link Invoke-WebRequest spends more time drawing
  # it than downloading, and the output is being read from a chat window anyway.
  $prev = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri "$dl/$setupName" -OutFile $setup -UseBasicParsing
  $ProgressPreference = $prev

  $size = (Get-Item $setup).Length
  if ($size -lt 500KB) {
    # A hub that answers /dl/ with an HTML error page would otherwise be
    # "installed" as a broken exe. The real installer is over a megabyte.
    Write-Error "Скачался файл на $size байт - это не установщик. Сообщите владельцу пространства."
    exit 1
  }

  # Запущенную копию закрываем: NSIS не сможет заменить работающий exe.
  Get-Process 'hegai-code' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host '==> Закрываю запущенный Hegai Code…'
    $_ | Stop-Process -Force
  }

  Write-Host '==> Устанавливаю…'
  # /S - тихая установка NSIS. Без него человеку пришлось бы кликать мастер,
  # который всё равно ничего не спрашивает: ставим в профиль, без выбора папки.
  $p = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) {
    Write-Error "Установщик вернул код $($p.ExitCode)."
    exit 1
  }

  # NSIS с installMode "currentUser" кладёт приложение в %LOCALAPPDATA%\<productName>,
  # то есть БЕЗ промежуточной папки Programs. Проверялось только по пути с ней, и
  # значит эта проверка валила установку, которая на самом деле прошла: exit 1 и
  # «приложение не найдено» на ровном месте (04.09.2026). Оба пути оставлены, а
  # порядок - настоящий первым: у кого-то может лежать копия из старой сборки.
  $exe = @(
    (Join-Path $env:LOCALAPPDATA 'Hegai Code\hegai-code.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Hegai Code\hegai-code.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1

  if (-not $exe) {
    Write-Error 'Установка прошла, но приложение не найдено. Сообщите владельцу пространства.'
    exit 1
  }

  Write-Host "==> Установлено: $exe"

  # Хаб запоминаем ДО запуска: приложение читает файл один раз при старте.
  # Каталог - тот, что Tauri считает app_config_dir для идентификатора
  # net.hegai.ccremote.windows (%APPDATA%\<идентификатор>). Для code.acme.test
  # файл убираем: по умолчанию хаб и так он, а старый файл от другого хаба
  # увёл бы приложение не туда. Запись без BOM и без перевода строки.
  $cfg = Join-Path $env:APPDATA 'net.hegai.ccremote.windows'
  $hubFile = Join-Path $cfg 'hub-url'
  if ($base -ne $defaultHub) {
    New-Item -ItemType Directory -Force -Path $cfg | Out-Null
    [System.IO.File]::WriteAllText($hubFile, $base)
    Write-Host "==> Сервер: $($base)"
  } else {
    Remove-Item -Force $hubFile -ErrorAction SilentlyContinue
  }

  Start-Process $exe
  if ($base -eq $defaultHub) {
    Write-Host 'Готово. В окне нажмите «Войти через HegAI».'
  } else {
    Write-Host "Готово. В окне войдите в свой аккаунт на $base."
  }
  Write-Host 'Сменить сервер позже: значок в трее -> «Сервер…».'
  Write-Host ''
  Write-Host 'Если Windows показал «Защитник Windows предотвратил запуск» - сборка пока'
  Write-Host 'не подписана сертификатом. Нажмите «Подробнее» -> «Выполнить в любом случае».'
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
