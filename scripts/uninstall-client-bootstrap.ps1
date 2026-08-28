param([Parameter(Mandatory=$true)][string]$ServerOrigin)
$ErrorActionPreference = 'Stop'
$ServerOrigin = $ServerOrigin.TrimEnd('/')

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = Get-ChildItem -Path (Join-Path $HOME '.vcpdeck\runtime\node') -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $node) { throw '[vcpdeck] 找不到 Node.js；请先安装 Node.js 后重试' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) "vcpdeck-uninstall-client-$PID.cjs"
try {
  Invoke-WebRequest -UseBasicParsing -Uri "$ServerOrigin/api/client-installer/assets/uninstall-client.cjs" -OutFile $tmp -TimeoutSec 120
  & $node $tmp
  if ($LASTEXITCODE -ne 0) { throw "卸载器退出码 $LASTEXITCODE" }
} finally { Remove-Item -Force $tmp -ErrorAction SilentlyContinue }
