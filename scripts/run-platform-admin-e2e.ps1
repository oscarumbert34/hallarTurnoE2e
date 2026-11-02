param(
    [switch]$SkipBrowserInstall
)

$ErrorActionPreference = 'Stop'

$e2eRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $e2eRoot)
$backendRoot = Join-Path $workspaceRoot 'turnero'
$frontendRoot = Join-Path $workspaceRoot 'turnero-front'
$envFile = Join-Path $e2eRoot '.env'
$testFile = 'tests/platform-admin-business-email.spec.ts'
$startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()

function Read-DotEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "No existe $Path. Copiá .env.example a .env y completalo."
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([^#][^=]*)=(.*)$') {
            $values[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
    return $values
}

function Require-Value {
    param([hashtable]$Values, [string]$Name)

    if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
        throw "Falta $Name en $envFile."
    }
    return $Values[$Name]
}

function Test-TcpPort {
    param([int]$Port)

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        return $task.Wait(500) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Wait-ForPort {
    param([int]$Port, [string]$Name, [int]$TimeoutSeconds = 90)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort -Port $Port) {
            Write-Host "$Name disponible en el puerto $Port." -ForegroundColor Green
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "$Name no quedó disponible en el puerto $Port dentro de $TimeoutSeconds segundos."
}

function Start-ManagedProcess {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory,
        [string]$LogPrefix
    )

    $stdout = Join-Path $e2eRoot "$LogPrefix.out.log"
    $stderr = Join-Path $e2eRoot "$LogPrefix.err.log"
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkingDirectory -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    $startedProcesses.Add($process)
    return $process
}

$configuration = Read-DotEnv -Path $envFile
$frontendUrl = Require-Value -Values $configuration -Name 'FRONTEND_URL'
$backendUrl = Require-Value -Values $configuration -Name 'BACKEND_URL'
$adminEmail = Require-Value -Values $configuration -Name 'E2E_USER_EMAIL'
Require-Value -Values $configuration -Name 'E2E_USER_PASSWORD' | Out-Null

if ($frontendUrl -ne 'http://localhost:4201') {
    throw "FRONTEND_URL debe ser http://localhost:4201 para este script. Valor actual: $frontendUrl"
}
if ($backendUrl -ne 'http://localhost:8081') {
    throw "BACKEND_URL debe ser http://localhost:8081 para este script. Valor actual: $backendUrl"
}

try {
    Push-Location $e2eRoot
    try {
        if (-not $SkipBrowserInstall) {
            Write-Host 'Verificando Chromium de Playwright...'
            & npx.cmd playwright install chromium
            if ($LASTEXITCODE -ne 0) { throw 'No se pudo instalar Chromium para Playwright.' }
        }

        if (-not (Test-TcpPort -Port 8081)) {
            Write-Host 'Levantando backend contra la base de desarrollo...'
            $previousProfile = $env:SPRING_PROFILES_ACTIVE
            $previousAdmins = $env:PLATFORM_ADMIN_ALLOWED_EMAILS
            $previousFrontend = $env:FRONTEND_BASE_URL
            $env:SPRING_PROFILES_ACTIVE = 'local,e2e'
            $env:PLATFORM_ADMIN_ALLOWED_EMAILS = $adminEmail
            $env:FRONTEND_BASE_URL = $frontendUrl
            Start-ManagedProcess -FilePath 'mvn.cmd' -ArgumentList @('spring-boot:run') `
                -WorkingDirectory $backendRoot -LogPrefix 'platform-admin-backend' | Out-Null
            $env:SPRING_PROFILES_ACTIVE = $previousProfile
            $env:PLATFORM_ADMIN_ALLOWED_EMAILS = $previousAdmins
            $env:FRONTEND_BASE_URL = $previousFrontend
        }
        else {
            Write-Host 'El puerto 8081 ya está ocupado; se reutilizará ese backend.' -ForegroundColor Yellow
            Write-Host "Verificá que PLATFORM_ADMIN_ALLOWED_EMAILS incluya $adminEmail." -ForegroundColor Yellow
        }

        if (-not (Test-TcpPort -Port 4201)) {
            Write-Host 'Levantando frontend en el puerto 4201...'
            Start-ManagedProcess -FilePath 'npm.cmd' `
                -ArgumentList @('start', '--', '--port', '4201', '--host', '127.0.0.1') `
                -WorkingDirectory $frontendRoot -LogPrefix 'platform-admin-frontend' | Out-Null
        }
        else {
            Write-Host 'El puerto 4201 ya está ocupado; se reutilizará ese frontend.' -ForegroundColor Yellow
        }

        Wait-ForPort -Port 8081 -Name 'Backend'
        Wait-ForPort -Port 4201 -Name 'Frontend'

        Write-Host "Ejecutando $testFile..." -ForegroundColor Cyan
        & npx.cmd playwright test $testFile
        if ($LASTEXITCODE -ne 0) { throw "Los E2E finalizaron con código $LASTEXITCODE." }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($process in $startedProcesses) {
        if (-not $process.HasExited) {
            Write-Host "Deteniendo proceso iniciado por el script: $($process.Id)..."
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
