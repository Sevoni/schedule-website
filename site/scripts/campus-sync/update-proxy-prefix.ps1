# ── Обновление CAMPUS_PROXY_PREFIX в GitHub Actions ─────────────────────
# Минтит свежий прокси-префикс (через sync.js --mint) и обновляет
# repository variable CAMPUS_PROXY_PREFIX через GitHub REST API.
# gh CLI не нужен — достаточно PAT-токена (см. инструкцию внизу).
#
# Запуск:
#   .\update-proxy-prefix.ps1                                # спросит repo и токен
#   .\update-proxy-prefix.ps1 -Repo owner/repo -Token ghp_…  # всё сразу
#   $env:GITHUB_TOKEN="ghp_…"; .\update-proxy-prefix.ps1 -Repo owner/repo
#
# Токен: GitHub → Settings → Developer settings → Fine-grained tokens →
# Generate new token → Repository access: Only select repositories →
# Permissions → Repository permissions → Actions → Variables: Read and write.
# (Или классический PAT со scope `repo`.)

param(
    [string]$Repo,
    [string]$Token
)

$ErrorActionPreference = 'Stop'

function Read-Secret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    if ($secure.Length -eq 0) { throw 'Пустой ввод' }
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

Write-Host '==> [1/2] Минтим свежий прокси-префикс (sync.js --mint)...'
$mintOut = & node (Join-Path $PSScriptRoot 'sync.js') --mint 2>&1
$mintText = $mintOut -join "`n"
Write-Host $mintText

$prefix = ($mintText -split "`r?`n" |
    Where-Object { $_ -match '^https://translated\.turbopages\.org/proxy_u/' } |
    Select-Object -First 1).Trim()
if (-not $prefix) {
    throw 'Не удалось извлечь префикс из вывода sync.js --mint. Запустите скрипт с российского IP.'
}
Write-Host "==> Префикс: $prefix"

if (-not $Repo) { $Repo = Read-Host 'Репозиторий (owner/repo)' }
if ($Repo -notmatch '^[^/]+/[^/]+$') { throw "Некорректный репозиторий: $Repo (ожидается owner/repo)" }
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
if (-not $Token) { $Token = Read-Secret 'GitHub PAT (скрытый ввод)' }

$headers = @{
    Authorization        = "Bearer $Token"
    Accept               = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

Write-Host "==> [2/2] Обновляем CAMPUS_PROXY_PREFIX в $Repo ..."
$uri = "https://api.github.com/repos/$Repo/actions/variables/CAMPUS_PROXY_PREFIX"
$body = @{ name = 'CAMPUS_PROXY_PREFIX'; value = $prefix } | ConvertTo-Json

try {
    $null = Invoke-RestMethod -Uri $uri -Method Get -Headers $headers
    $null = Invoke-RestMethod -Uri $uri -Method Patch -Headers $headers -ContentType 'application/json' -Body $body
    Write-Host "OK: переменная обновлена (существовала)."
}
catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 404) {
        $null = Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType 'application/json' -Body $body
        Write-Host 'OK: переменная создана.'
    } else {
        throw
    }
}

Write-Host ''
Write-Host 'Готово. Запустите workflow в GitHub (Actions → Campus sync → Run workflow),'
Write-Host 'или дождитесь ближайшего запуска по расписанию.'
