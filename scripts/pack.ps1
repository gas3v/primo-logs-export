# Проверяет файлы расширения и собирает два ZIP:
#   dist/primo-logs-export-<version>.zip        для Chrome Web Store
#   dist/primo-logs-export-<version>-install.zip для коллег: то же + УСТАНОВКА.txt
# Запуск: powershell -ExecutionPolicy Bypass -File scripts\pack.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$manifest = Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.version) { throw 'В manifest.json нет version' }

$include = @('manifest.json', 'background.js', 'exporter.js', 'xlsx-writer.js', 'csv-writer.js', 'icons')

# Chrome требует валидный UTF-8 и не принимает «несимволы» U+FFFE/U+FFFF
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
# Невидимые символы (нулевой ширины и BOM) в коде пишем только escape-последовательностями.
# Шаблон собран из кодов символов, чтобы в самом скрипте не было невидимых символов.
$invisible = '[{0}-{1}{2}]' -f [char]0x200B, [char]0x200D, [char]0xFEFF
$bad = @()
foreach ($f in Get-ChildItem -File -Include *.js, *.json -Path ($include | ForEach-Object { Join-Path $root $_ }) -Recurse) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $bad += "$($f.Name): UTF-8 BOM"; continue }
  try { $text = $utf8.GetString($bytes) } catch { $bad += "$($f.Name): невалидный UTF-8"; continue }
  if ($text -match $invisible) { $bad += "$($f.Name): невидимый символ U+200B..U+200D/U+FEFF (замените на escape-последовательность, см. docs/architecture.md)" }
  if ($text.IndexOf([char]0xFFFE) -ge 0 -or $text.IndexOf([char]0xFFFF) -ge 0) { $bad += "$($f.Name): символ U+FFFE/U+FFFF (используйте escape \uFFFE)" }
}
if ($bad) { $bad | ForEach-Object { Write-Host "ОШИБКА  $_" -ForegroundColor Red }; exit 1 }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
# Compress-Archive в PowerShell 5.1 пишет пути с «\», магазин их не понимает, поэтому собираем вручную с «/»
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-Zip($zip, $items) {
  if (Test-Path $zip) { Remove-Item $zip -Force }
  $archive = [IO.Compression.ZipFile]::Open($zip, 'Create')
  try {
    foreach ($item in $items) {
      $full = Join-Path $root $item
      $files = if (Test-Path $full -PathType Container) { Get-ChildItem $full -File -Recurse } else { Get-Item $full }
      foreach ($f in $files) {
        $entry = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $entry)
      }
    }
  } finally { $archive.Dispose() }
  Write-Host "Готово: $zip" -ForegroundColor Green
}

New-Zip (Join-Path $dist "primo-logs-export-$($manifest.version).zip") $include
New-Zip (Join-Path $dist "primo-logs-export-$($manifest.version)-install.zip") ($include + 'УСТАНОВКА.txt')
