param(
    [Parameter(Mandatory = $true)][string]$StartTime,
    [Parameter(Mandatory = $true)][string]$EndTime,
    [int]$OrganizationId = 1053513,
    [string]$CaCertificatePath
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$branch = & git -C $repo branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'staging') {
    throw 'Use the staging checkout only.'
}
if ($env:RENDER) { throw 'This importer is for your private local terminal, not a hosted service.' }
if ($env:PAID_INFRA_ENABLED -and $env:PAID_INFRA_ENABLED -ne '0') {
    throw 'Set PAID_INFRA_ENABLED=0 before importing supplier statistics.'
}
if ($CaCertificatePath -and -not (Test-Path -LiteralPath $CaCertificatePath -PathType Leaf)) {
    throw 'CA certificate file does not exist.'
}

$secretPath = Join-Path $env:LOCALAPPDATA 'PROBE\secrets\zyte-dashboard-key.clixml'
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw 'The DPAPI-protected Zyte Stats API key file was not found.'
}
$credential = Import-Clixml -LiteralPath $secretPath
$secureKey = $credential
$pointer = [IntPtr]::Zero
$key = $null
$names = @('PROBE_STAGING', 'PAID_INFRA_ENABLED', 'ZYTE_STATS_API_KEY', 'DATABASE_URL', 'DATABASE_CA_CERT_PATH')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

Write-Host 'This makes read-only Zyte Stats API GET requests and writes only USD aggregate evidence to the separate supplier-stats tables.'
Write-Host 'It does not run extractions, modify customer balances, or make payments.'
Write-Host 'Copy the entire staging Session pooler URI from Supabase Connect; the password prompt is hidden.'
$confirmation = Read-Host 'Type zyte-stats-usd-only to confirm this staging evidence import'
if ($confirmation -ne 'zyte-stats-usd-only') {
    throw 'Import not confirmed. Nothing changed.'
}
$uri = Read-Host 'Staging Session pooler URI (with [YOUR-PASSWORD] placeholder)' -AsSecureString
$uriPointer = [IntPtr]::Zero
$passwordPointer = [IntPtr]::Zero
$password = $null
Push-Location $repo
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $uriPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($uri)
    $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($uriPointer)
    if ($env:DATABASE_URL.Contains('[YOUR-PASSWORD]')) {
        if ([regex]::Matches($env:DATABASE_URL, '\[YOUR-PASSWORD\]').Count -ne 1) {
            throw 'Expected one database password placeholder.'
        }
        $password = Read-Host 'Supabase project database password' -AsSecureString
        if ($password.Length -eq 0) { throw 'Database password cannot be empty.' }
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
        $env:DATABASE_URL = $env:DATABASE_URL.Replace('[YOUR-PASSWORD]',
            [Uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)))
    }
    $env:PROBE_STAGING = '1'
    $env:PAID_INFRA_ENABLED = '0'
    $env:ZYTE_STATS_API_KEY = $key
    if ($CaCertificatePath) {
        $env:DATABASE_CA_CERT_PATH = (Resolve-Path -LiteralPath $CaCertificatePath).Path
    }
    & node scripts\zyte-stats-import.js --organization-id $OrganizationId --start-time $StartTime --end-time $EndTime
    if ($LASTEXITCODE -ne 0) {
        throw 'Stats import failed. No customer ledger or payment path was run.'
    }
}
finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    foreach ($memory in @($pointer, $uriPointer, $passwordPointer)) {
        if ($memory -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($memory) }
    }
    if ($null -ne $key) { $key = $null }
    if ($null -ne $credential -and $credential -is [System.Security.SecureString]) { $credential.Dispose() }
    if ($null -ne $password) { $password.Dispose() }
    $uri.Dispose()
    Pop-Location
}
