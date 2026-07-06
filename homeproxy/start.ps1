# homeproxy — ローカルプロキシを起動する PowerShell スクリプト
#
# 使い方:
#   cd homeproxy
#   .\start.ps1
#
# venv があれば activate してから呼ぶこと（tensorflow-cpu などと同居しても良し）。

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# venv の自動アクティベート
$VenvActivate = Join-Path (Split-Path $Here -Parent) ".venv\Scripts\Activate.ps1"
if (Test-Path $VenvActivate -PathType Leaf) {
    Write-Host "[homeproxy] activating venv: $VenvActivate" -ForegroundColor DarkGray
    . $VenvActivate
}

# pproxy 未インストールなら入れる
try {
    python -c "import pproxy" 2>$null
    if ($LASTEXITCODE -ne 0) { throw "pproxy missing" }
} catch {
    Write-Host "[homeproxy] installing pproxy..." -ForegroundColor Yellow
    python -m pip install -q -r (Join-Path $Here "requirements.txt")
}

# 実行
python (Join-Path $Here "server.py")
