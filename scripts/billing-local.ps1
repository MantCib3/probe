param(
    [ValidateSet('Check', 'Migrate', 'Allocate', 'Post')]
    [string]$Action = 'Check',
    [string]$CaCertificatePath,
    [string]$StatsImportId,
    [string]$AllocationManifest,
    [string]$AllocationId
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$branch = & git -C $repo branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'staging') {
    throw 'Use the staging checkout only.'
}
if ($env:RENDER) {
    throw 'This helper is for your private local terminal, not a hosted service.'
}
if ($CaCertificatePath -and -not (Test-Path -LiteralPath $CaCertificatePath -PathType Leaf)) {
    throw 'CA certificate file does not exist.'
}
if ($Action -eq 'Migrate') {
    $confirmation = Read-Host 'This creates billing tables. Type probe-billing-staging to confirm the target project'
    if ($confirmation -ne 'probe-billing-staging') {
        throw 'Migration not confirmed. Nothing changed.'
    }
}
if ($Action -eq 'Allocate') {
    if ($StatsImportId -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$' -or
        -not $AllocationManifest -or -not (Test-Path -LiteralPath $AllocationManifest -PathType Leaf)) {
        throw 'Allocation requires a Stats import UUID and an existing private manifest JSON file.'
    }
    $AllocationManifest = (Resolve-Path -LiteralPath $AllocationManifest).Path
    if ($env:PAID_WORKER_ENABLED -and $env:PAID_WORKER_ENABLED -ne '0') {
        throw 'Stop paid execution before allocating supplier evidence.'
    }
    $confirmation = Read-Host 'This writes USD allocation evidence only, not customer charges. Type probe-allocation-staging to confirm'
    if ($confirmation -ne 'probe-allocation-staging') {
        throw 'Allocation not confirmed. Nothing changed.'
    }
}

if ($Action -eq 'Post') {
    if ($AllocationId -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') {
        throw 'Posting requires a saved allocation UUID.'
    }
    $confirmation = Read-Host 'This posts verified customer usage in USD, but makes no payments. Type probe-usd-post-staging to confirm'
    if ($confirmation -ne 'probe-usd-post-staging') { throw 'Posting not confirmed. Nothing changed.' }
}

$names = @('DATABASE_URL', 'DATABASE_CA_CERT_PATH', 'PROBE_STAGING', 'PAID_INFRA_ENABLED',
    'PAID_WORKER_ENABLED', 'PAID_ALLOCATION_ENABLED', 'PAID_RECONCILIATION_ENABLED')
$previous = @{}
foreach ($name in $names) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Write-Host 'Copy the ENTIRE Session pooler URI straight from Supabase Connect.'
Write-Host 'Leave [YOUR-PASSWORD] unchanged: the helper will ask for the password separately.'
Write-Host 'Paste works with hidden input; no characters will appear. Do not paste into chat.'
$uri = Read-Host 'Staging session-pooler URI' -AsSecureString
$pointer = [IntPtr]::Zero
$passwordPointer = [IntPtr]::Zero
$password = $null
Push-Location $repo
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($uri)
    $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    Write-Host ('Received input length: {0} characters (contents withheld).' -f $uri.Length)
    if ($env:DATABASE_URL.Contains('[YOUR-PASSWORD]')) {
        if ([regex]::Matches($env:DATABASE_URL, '\[YOUR-PASSWORD\]').Count -ne 1) {
            throw 'Expected one password placeholder in the Supabase URI.'
        }
        $password = Read-Host 'Supabase PROJECT DATABASE password (not your login password; enter it exactly, without encoding)' -AsSecureString
        if ($password.Length -eq 0) {
            throw 'Database password cannot be empty.'
        }
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
        $env:DATABASE_URL = $env:DATABASE_URL.Replace('[YOUR-PASSWORD]',
            [Uri]::EscapeDataString([Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)))
        Write-Host 'Password inserted and encoded privately; Supabase username preserved.'
    }
    $env:PROBE_STAGING = '1'
    $env:PAID_INFRA_ENABLED = '0'
    if ($CaCertificatePath) {
        $env:DATABASE_CA_CERT_PATH = (Resolve-Path -LiteralPath $CaCertificatePath).Path
    }
    @'
const { createPool } = require('./lib/billing/db');
const { checkDatabase, safeDatabaseError } = require('./scripts/billing-check');
(async () => {
  const pool = createPool();
  try {
    console.log(JSON.stringify({ok: true, database: await checkDatabase(pool),
      providerRequests: 0, paymentRequests: 0, databaseWrites: 0}));
  } finally { await pool.end(); }
})().catch(error => {
  console.error('[billing:local] ' + safeDatabaseError(error));
  process.exitCode = 1;
});
'@ | & node -
    if ($LASTEXITCODE -ne 0) {
        throw 'Read-only connection check failed. No migration attempted. Do not disable TLS verification.'
    }
    if ($Action -eq 'Migrate') {
        & node scripts\billing-migrate.js
        if ($LASTEXITCODE -ne 0) {
            throw 'Migration failed. Review sanitized output; no provider or payment requests were made.'
        }
    }
    if ($Action -eq 'Allocate') {
        $env:PAID_WORKER_ENABLED = '0'
        $env:PAID_ALLOCATION_ENABLED = '1'
        & node scripts\billing-allocate.js $StatsImportId $AllocationManifest
        if ($LASTEXITCODE -ne 0) {
            throw 'Allocation held for review. No customer charges or payments were posted.'
        }
        if ($Action -eq 'Post') {
            $env:PAID_WORKER_ENABLED = '0'
            $env:PAID_RECONCILIATION_ENABLED = '1'
            & node scripts\billing-reconcile.js $AllocationId
            if ($LASTEXITCODE -ne 0) { throw 'USD posting failed. No payments or supplier requests were made.' }
        }
    }
}
finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    if ($null -ne $password) {
        $password.Dispose()
    }
    $uri.Dispose()
    Pop-Location
}
