# homeproxy — SSH リバーストンネルを VPS に張る PowerShell スクリプト
#
# 使い方:
#   cd homeproxy
#   .\tunnel.ps1
#
# なにをするか:
#   家の PC で SSH を VPS に接続し、リバーストンネル (-R) で
#   VPS の 127.0.0.1:$SSH_REMOTE_PORT を 家の PC の localhost:$PROXY_PORT に
#   転送する。これで VPS 側は 127.0.0.1:8888 を叩くだけで 家のプロキシに到達できる。
#
# 注意: このウィンドウは開けっばなしにすること。閉じるとトンネルも切れる。

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# .env 読み込み
$EnvFile = Join-Path $Here ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Host "[tunnel] .env が見つかりません。.env.example をコピーして作成してください。" -ForegroundColor Red
    exit 1
}
$envs = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
        $parts = $line.Split("=", 2)
        $envs[$parts[0].Trim()] = $parts[1].Trim()
    }
}

$SshUser       = if ($envs.SSH_USER)        { $envs.SSH_USER }        else { "root" }
$SshHost       = if ($envs.SSH_HOST)        { $envs.SSH_HOST }        else { "" }
$SshPort       = if ($envs.SSH_PORT)        { $envs.SSH_PORT }        else { "22" }
$RemotePort    = if ($envs.SSH_REMOTE_PORT) { $envs.SSH_REMOTE_PORT } else { "8888" }
$LocalPort     = if ($envs.PROXY_PORT)      { $envs.PROXY_PORT }      else { "8888" }
$SshKey        = if ($envs.SSH_KEY)         { $envs.SSH_KEY }         else { "" }

if (-not $SshHost) {
    Write-Host "[tunnel] .env の SSH_HOST が未設定です。" -ForegroundColor Red
    exit 1
}

# SSH 鍵ファイルの存在チェックと権限ガイド
$SshKeyArgs = @()
if ($SshKey) {
    if (-not (Test-Path $SshKey -PathType Leaf)) {
        Write-Host "[tunnel] SSH_KEY に指定されたファイルが存在しません: $SshKey" -ForegroundColor Red
        exit 1
    }
    Write-Host "[tunnel] using SSH key: $SshKey" -ForegroundColor DarkGray
    # Windows では OpenSSH が鍵の権限を厳しくチェックするので、
    # icacls で現在ユーザー以外を削っておくと安全。
    # （もし Permissions 0644 でロード拒否される場合の自動対応）
    try {
        $acl = Get-Acl $SshKey
        $currentUser = "$env:USERDOMAIN\$env:USERNAME"
        $needFix = $true
        foreach ($ace in $acl.Access) {
            if ($ace.IdentityReference.Value -ne $currentUser) { $needFix = $true; break }
            $needFix = $false
        }
        if ($needFix) {
            Write-Host "[tunnel] tightening key file permissions (removing inherited ACLs)..." -ForegroundColor DarkGray
            icacls $SshKey /inheritance:r /grant:r "${currentUser}:F" | Out-Null
        }
    } catch {
        Write-Host "[tunnel] warning: could not adjust key ACL: $_" -ForegroundColor Yellow
    }
    $SshKeyArgs = @("-i", $SshKey, "-o", "IdentitiesOnly=yes")
} else {
    Write-Host "[tunnel] no SSH_KEY set; using default identity / ssh-agent" -ForegroundColor DarkGray
}

Write-Host "[tunnel] forwarding: VPS 127.0.0.1:${RemotePort}  <---  home 127.0.0.1:${LocalPort}" -ForegroundColor Green
Write-Host "[tunnel] ssh target: ${SshUser}@${SshHost}:${SshPort}" -ForegroundColor DarkGray
Write-Host "[tunnel] Ctrl+C to stop." -ForegroundColor DarkGray

# 自動再接続ループ（切れたら 5s 後に再張り）
while ($true) {
    # -N: コマンド実行しない (トンネル専用)
    # -T: PTY 割り当てなし
    # -o ServerAliveInterval=30: 30s ごとにキープアライブ
    # -o ExitOnForwardFailure=yes: -R が失敗したら SSH も落とす
    # -R 127.0.0.1:remote:localhost:local: VPS の 127.0.0.1:remote を 家の localhost:local に
    $sshArgs = @(
        "-N", "-T",
        "-p", $SshPort,
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "StrictHostKeyChecking=accept-new"
    ) + $SshKeyArgs + @(
        "-R", "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}",
        "${SshUser}@${SshHost}"
    )
    & ssh @sshArgs

    $code = $LASTEXITCODE
    Write-Host "[tunnel] ssh exited with code $code. reconnecting in 5s..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
