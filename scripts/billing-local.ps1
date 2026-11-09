param(
    [ValidateSet('Check', 'Migrate')]
    [string]$Action = 'Check',
    [string]$CaCertificatePath
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

$names = @('DATABASE_URL', 'DATABASE_CA_CERT_PATH', 'PROBE_STAGING', 'PAID_INFRA_ENABLED')
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
