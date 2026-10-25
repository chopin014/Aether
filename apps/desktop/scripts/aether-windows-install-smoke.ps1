# Copyright 2026 Gabriel. SPDX-License-Identifier: AGPL-3.0-only

[CmdletBinding()]
param (
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installer = (Resolve-Path $InstallerPath).Path
$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$installDirectory = Join-Path $env:LOCALAPPDATA "Programs\Aether-release-smoke-$PID"
$profileDirectory = Join-Path $env:TEMP "Aether-profile-smoke-$PID"
$application = Join-Path $installDirectory "Aether.exe"
$uninstaller = Join-Path $installDirectory "Uninstall Aether.exe"
$appArchive = Join-Path $installDirectory "resources\app.asar"
$updateConfig = Join-Path $installDirectory "resources\app-update.yml"
$profileMarker = Join-Path $profileDirectory "release-smoke.marker"

function Invoke-SilentInstall {
    param ([string]$Stage)

    Write-Host "Running the NSIS installer ($Stage)."
    $process = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$installDirectory") -PassThru
    if (-not $process.WaitForExit(300000)) {
        & taskkill.exe /F /T /PID $process.Id | Out-Null
        throw "The NSIS installer timed out during $Stage."
    }
    if ($process.ExitCode -ne 0) {
        throw "The NSIS installer failed during $Stage with exit code $($process.ExitCode)."
    }
}

function Assert-InstalledPackage {
    param ([string]$Stage)

    if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
        throw "Aether.exe is missing after $Stage."
    }
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "The per-user install is missing its uninstaller after $Stage."
    }
    if (-not (Test-Path -LiteralPath $appArchive -PathType Leaf)) {
        throw "resources/app.asar is missing after $Stage."
    }
    if (-not (Test-Path -LiteralPath $updateConfig -PathType Leaf)) {
        throw "resources/app-update.yml is missing after $Stage."
    }

    $nodeScript = @'
import { extractFile } from "@electron/asar";
const pkg = JSON.parse(extractFile(process.argv[1], "package.json").toString("utf8"));
process.stdout.write(pkg.version);
'@
    $packageVersion = & node --input-type=module -e $nodeScript $appArchive
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read package.json from the installed app.asar after $Stage."
    }
    if ([string]$packageVersion -ne $ExpectedVersion) {
        throw "Installed app.asar version '$packageVersion' does not match '$ExpectedVersion' after $Stage."
    }

    $configLines = Get-Content -LiteralPath $updateConfig
    $expectedSettings = @{
        provider = "github"
        owner    = "chopin014"
        repo     = "Aether"
        channel  = "latest"
    }
    foreach ($settingName in $expectedSettings.Keys) {
        $settingLines = @($configLines | Where-Object { $_ -match "^\s*$settingName\s*:" })
        if ($settingLines.Count -ne 1) {
            throw "Installed app-update.yml must have one '$settingName' setting after $Stage."
        }

        $settingValue = ($settingLines[0] -split ":", 2)[1].Trim().Trim('"').Trim("'")
        if ($settingValue -ne $expectedSettings[$settingName]) {
            throw "Installed app-update.yml has unexpected '$settingName' value '$settingValue' after $Stage."
        }
    }
}

function Start-InstalledApplication {
    param ([string]$Stage)

    $previousProfileDirectory = $env:ELEMENT_PROFILE_DIR
    $env:ELEMENT_PROFILE_DIR = $profileDirectory
    try {
        $process = Start-Process -FilePath $application -ArgumentList @("--no-update", "--disable-gpu") -PassThru
    } finally {
        $env:ELEMENT_PROFILE_DIR = $previousProfileDirectory
    }

    $deadline = (Get-Date).AddSeconds(60)
    while ($process.MainWindowHandle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) {
            throw "Aether exited before creating its main window during $Stage (exit code $($process.ExitCode))."
        }
        Start-Sleep -Seconds 1
    }

    $process.Refresh()
    if ($process.HasExited) throw "Aether exited during $Stage (exit code $($process.ExitCode))."
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "Aether did not create its main window during $Stage."
    }
    if (-not (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
        throw "Aether did not create its isolated user profile during $Stage."
    }

    Start-Sleep -Seconds 5
    $process.Refresh()
    if ($process.HasExited) throw "Aether exited during $Stage (exit code $($process.ExitCode))."
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) throw "Aether closed its main window during $Stage."
    return $process
}

function Stop-InstalledApplication {
    param ([System.Diagnostics.Process]$Process)

    $Process.Refresh()
    if (-not $Process.HasExited) {
        # Stop only this test launch and the child processes it created.
        & taskkill.exe /F /T /PID $Process.Id | Out-Null
        Start-Sleep -Seconds 2
        $Process.Refresh()
        if (-not $Process.HasExited) throw "Could not stop the Aether smoke process $($Process.Id)."
    }
}

if (-not (Test-Path -LiteralPath $env:LOCALAPPDATA -PathType Container)) {
    throw "LOCALAPPDATA is not available for a per-user install."
}

Push-Location $desktopRoot
try {
    Invoke-SilentInstall "initial install"
    Assert-InstalledPackage "initial install"

    $firstLaunch = Start-InstalledApplication "initial launch"
    Stop-InstalledApplication $firstLaunch

    $markerValue = [guid]::NewGuid().ToString()
    Set-Content -LiteralPath $profileMarker -Value $markerValue -NoNewline

    Invoke-SilentInstall "same-version reinstall"
    Assert-InstalledPackage "same-version reinstall"
    if ((Get-Content -LiteralPath $profileMarker -Raw) -ne $markerValue) {
        throw "The same-version reinstall removed or changed the user's profile marker."
    }

    $secondLaunch = Start-InstalledApplication "post-reinstall launch"
    Stop-InstalledApplication $secondLaunch
    Write-Host "Same-version NSIS reinstall smoke passed."
    Write-Host "It verifies installer relaunch and profile preservation, not a different-version updater install."
} finally {
    Pop-Location
}
